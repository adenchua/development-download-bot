import { promisify } from "util";
import { execFile, spawn } from "child_process";
import { createWriteStream, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import archiver from "archiver";
import { formatISO } from "date-fns";
import pLimit from "p-limit";

import { ResolvedImage, AuditSeverityCounts, DockerMetadata, ImageMetadata } from "./types";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

const TRIVY_IMAGE = `aquasec/trivy:${process.env.TRIVY_VERSION ?? "latest"}`;
const COPA_TIMEOUT = process.env.COPA_TIMEOUT ?? "30m";

// Copa runs as a local binary (installed in the Docker image). Reports are written
// to this directory so Copa can read them directly — no named Docker volume needed.
const COPA_REPORTS_DIR = "/tmp/copa-reports";

// Naming: "latest" tag gets a short digest suffix; all other tags use tag only.
// Slashes in image names are replaced with dashes (e.g. bitnami/nginx → bitnami-nginx).
function tarballName(name: string, tag: string, shortDigest?: string): string {
  const safeName = name.replace(/\//g, "-");
  if (tag === "latest" && shortDigest) {
    return `${safeName}-latest-${shortDigest}.tar`;
  }
  return `${safeName}-${tag}.tar`;
}

// Reads org.opencontainers.image.version label from a pulled image.
// Returns the trimmed version string, or undefined if absent or on any error.
async function getResolvedTag(imageRef: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      imageRef,
      "--format",
      '{{index .Config.Labels "org.opencontainers.image.version"}}',
    ]);
    const version = stdout.trim();
    return version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

// Returns the first 8 hex chars of the sha256 digest for an image, used to
// make "latest"-tagged filenames unique across pulls at different points in time.
async function getShortDigest(imageRef: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", imageRef, "--format", "{{index .RepoDigests 0}}"]);
    const repoDigest = stdout.trim(); // e.g. "nginx@sha256:a5de3e7a..."
    const sha256Match = /sha256:([0-9a-f]+)/.exec(repoDigest);
    if (sha256Match) return sha256Match[1].slice(0, 8);
  } catch {
    // digest unavailable — fall back to no suffix
  }
  return undefined;
}

interface TrivyResult {
  Results?: Array<{
    Vulnerabilities?: Array<{
      Severity: string;
    }>;
  }>;
}

// Runs trivy against a pulled image.
// When reportPath is given, this is a pre-scan for Copa: the JSON report is written
// to the local path so Copa (running as a binary) can read it directly.
// Returns null on any scan or parse failure — callers must run Copa when null is returned.
async function runTrivyScan(imageRef: string, reportPath?: string): Promise<AuditSeverityCounts | null> {
  const counts: AuditSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

  logger.log(`[trivy] ${reportPath ? "pre-scan" : "post-patch scan"}: ${imageRef}`);

  const dockerArgs: string[] = [
    "run",
    "--rm",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    "trivy-cache:/root/.cache/trivy",
    TRIVY_IMAGE,
    "image",
    "--format",
    "json",
    "--quiet",
    "--cache-ttl",
    "1h",
    imageRef,
  ];

  let stdout = "";
  try {
    const result = await execFileAsync("docker", dockerArgs, { maxBuffer: 1024 * 1024 * 1024, timeout: 600_000 });
    stdout = result.stdout;
  } catch (err: unknown) {
    // trivy exits non-zero when vulnerabilities are found — read stdout anyway
    if (err && typeof err === "object" && "stdout" in err) {
      stdout = (err as { stdout: string }).stdout;
    } else {
      logger.error(`[trivy] scan failed for ${imageRef}:`, err);
      return null;
    }
  }

  if (reportPath) {
    mkdirSync(COPA_REPORTS_DIR, { recursive: true });
    writeFileSync(reportPath, stdout);
  }

  try {
    const report = JSON.parse(stdout) as TrivyResult;
    for (const result of report.Results ?? []) {
      for (const vuln of result.Vulnerabilities ?? []) {
        const severity = vuln.Severity.toLowerCase() as keyof AuditSeverityCounts;
        if (severity in counts) counts[severity]++;
        else counts.unknown++;
      }
    }
  } catch {
    logger.error(`[trivy] failed to parse output for ${imageRef}:`, stdout.slice(0, 500));
    return null;
  }

  return counts;
}

function allZero(counts: AuditSeverityCounts): boolean {
  return counts.critical === 0 && counts.high === 0 && counts.medium === 0 && counts.low === 0 && counts.unknown === 0;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Spawns a process and streams its stdout/stderr line-by-line to console in real time.
// Collects both streams so callers can inspect them after the process exits.
function spawnAndLog(bin: string, args: string[], logPrefix: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n").filter((line) => line.trim())) {
        logger.log(`${logPrefix} ${line}`);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n").filter((line) => line.trim())) {
        logger.log(`${logPrefix} ${line}`);
      }
    });

    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

interface HardenResult {
  hardened: boolean;
  patchedTag?: string;
  patchedPackageCount?: number;
  hardenReason?: string;
}

// Best-effort parse of copa stdout to extract a count of patched packages.
function parseCopaPatchedCount(text: string): number | undefined {
  const match = /(?:patched|updated)\s+(\d+)/i.exec(text);
  return match ? parseInt(match[1], 10) : undefined;
}

// Runs copa against an image using a pre-generated trivy JSON report.
// Three outcomes:
//   - success → returns hardened:true with patchedTag set
//   - no patchable CVEs (copa errors with a recognisable message) → hardened:true, no patchedTag
//   - any other failure → hardened:false with reason set
async function runCopaPatch(imageRef: string, reportPath: string, patchedTag: string): Promise<HardenResult> {
  logger.log(`[copa] patching ${imageRef}`);
  const result = await spawnAndLog(
    "copa",
    ["patch", "-i", imageRef, "-r", reportPath, "-t", patchedTag, "--timeout", COPA_TIMEOUT],
    "[copa]",
  );

  // Copa may exit non-zero OR exit 0 when there is nothing to patch; check both cases.
  const combinedOutput = result.stdout + result.stderr;
  const isNoop = /no.{0,30}(patches|vulnerab|updat)|already.{0,20}up.to.date/i.test(combinedOutput);

  if (result.exitCode !== 0) {
    if (isNoop) return { hardened: true, patchedPackageCount: 0 };

    const reason =
      result.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/^Unable to find image/.test(line))
        .filter((line) => !/^(Run|See) ['"]?docker/.test(line))
        .join("; ")
        .slice(0, 300) || "copa error";
    logger.error(`[copa] hardening failed for ${imageRef}:`, result.stderr.trim());
    return { hardened: false, hardenReason: reason };
  }

  // Copa exited 0 but may still have patched nothing (some versions exit 0 and never create
  // the output tag when 0 packages are patchable — don't return patchedTag in that case).
  if (isNoop) return { hardened: true, patchedPackageCount: 0 };

  return {
    hardened: true,
    patchedTag,
    patchedPackageCount: parseCopaPatchedCount(result.stdout),
  };
}

interface PullResult {
  status: "fulfilled";
  metadata: ImageMetadata;
  tarPath: string;
  audit: AuditSeverityCounts;
}

interface PullFailure {
  status: "rejected";
  name: string;
  version: string;
  error: string;
}

async function pullAndSave(image: ResolvedImage, outputDir: string, jobId: string): Promise<PullResult> {
  const originalRef = `${image.name}:${image.tag}`;
  await execFileAsync("docker", ["pull", "--platform", image.platform, originalRef], { timeout: 1_800_000 });

  // For "latest"-tagged images, try to resolve to the concrete version via the OCI label.
  // workingRef holds the canonical ref we'll save under (resolved version if available, else original).
  let workingRef = originalRef;
  let resolvedTag: string | undefined;
  if (image.tag === "latest") {
    resolvedTag = await getResolvedTag(originalRef);
    if (resolvedTag) {
      workingRef = `${image.name}:${resolvedTag}`;
      await execFileAsync("docker", ["tag", originalRef, workingRef]);
    }
  }

  // Capture the source digest before copa patches the image bytes. Used only
  // for filename disambiguation when "latest" has no OCI version label.
  let shortDigest: string | undefined;
  if (image.tag === "latest" && !resolvedTag) {
    shortDigest = await getShortDigest(workingRef);
  }

  // Harden via copa (best-effort). Windows images are skipped upfront — copa is linux-only.
  const safeName = image.name.replace(/\//g, "-");
  const reportPath = join(COPA_REPORTS_DIR, `${jobId}-${safeName}-${image.tag}.json`);
  const copaTag = `${image.name}:copa-${jobId}`;

  const zeroAudit: AuditSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  let hardenResult: HardenResult;
  let audit: AuditSeverityCounts;

  if (image.platform.startsWith("windows/")) {
    hardenResult = { hardened: false, hardenReason: "windows images not supported by copa" };
    audit = (await runTrivyScan(workingRef)) ?? zeroAudit;
  } else {
    const preScanCounts = await runTrivyScan(workingRef, reportPath);
    if (preScanCounts !== null && allZero(preScanCounts)) {
      // Confirmed clean — no CVEs to patch, skip Copa and post-scan entirely.
      hardenResult = { hardened: true, patchedPackageCount: 0 };
      audit = preScanCounts;
      try { unlinkSync(reportPath); } catch { /* best-effort cleanup of temp trivy report */ }
    } else {
      hardenResult = await runCopaPatch(workingRef, reportPath, copaTag);
      try { unlinkSync(reportPath); } catch { /* best-effort cleanup of temp trivy report */ }
      if (hardenResult.patchedTag) {
        try {
          // Re-tag the patched image as workingRef so docker save / docker load preserve the user-facing tag.
          await execFileAsync("docker", ["tag", hardenResult.patchedTag, workingRef]);
        } catch {
          // Copa exited 0 but the patched tag is not in the Docker daemon image store
          // (seen with copa 0.14.x — image may land in BuildKit containerd store instead).
          // Fall back to the original unpatched image so the download still succeeds.
          logger.error(`[copa] patched tag ${hardenResult.patchedTag} not found after copa exited 0 — saving unpatched image`);
          hardenResult = { hardened: false, hardenReason: "copa exited 0 but output tag not found in Docker daemon" };
        }
      }
      // Post-patch scan — this is the one recorded in metadata.json.audit.
      audit = (await runTrivyScan(workingRef)) ?? zeroAudit;
    }
  }

  const finalTag = resolvedTag ?? image.tag;
  const filename = tarballName(image.name, finalTag, shortDigest);
  const tarPath = join(outputDir, filename);

  await execFileAsync("docker", ["save", workingRef, "-o", tarPath], { timeout: 600_000 });

  // Clean up all tags we created or pulled.
  const refsToRemove: string[] = [originalRef];
  if (workingRef !== originalRef) refsToRemove.push(workingRef);
  if (hardenResult.patchedTag && hardenResult.patchedTag !== workingRef) {
    refsToRemove.push(hardenResult.patchedTag);
  }
  await execFileAsync("docker", ["rmi", ...refsToRemove]).catch(() => {});

  return {
    status: "fulfilled",
    metadata: {
      name: image.name,
      version: finalTag,
      tarball: filename,
      digest: shortDigest ? `sha256:${shortDigest}` : undefined,
      hardened: hardenResult.hardened,
      patchedPackageCount: hardenResult.patchedPackageCount,
      hardenReason: hardenResult.hardenReason,
    },
    tarPath,
    audit,
  };
}

function mergeAuditCounts(counts: AuditSeverityCounts[]): AuditSeverityCounts {
  return counts.reduce(
    (acc, cur) => ({
      critical: acc.critical + cur.critical,
      high: acc.high + cur.high,
      medium: acc.medium + cur.medium,
      low: acc.low + cur.low,
      unknown: acc.unknown + cur.unknown,
    }),
    { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
  );
}

export async function downloadAndZip(images: ResolvedImage[], jobId: string): Promise<void> {
  const OUTPUT_DIR = resolve("output");
  const TEMP_DIR = resolve("output");
  const startedAt = formatISO(new Date());

  const limit = pLimit(4);
  const results = await Promise.allSettled(images.map((image) => limit(() => pullAndSave(image, TEMP_DIR, jobId))));

  const succeeded: PullResult[] = [];
  const failed: PullFailure[] = [];

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const image = images[index];
    if (result.status === "fulfilled") {
      succeeded.push(result.value);
    } else {
      failed.push({
        status: "rejected",
        name: image.name,
        version: image.tag,
        error: (result.reason instanceof Error ? result.reason.message.split("\n")[0] : String(result.reason))
          .replace(/\/[^\s,]+|[A-Z]:\\[^\s,]+/g, "<path>")
          .slice(0, 200),
      });
    }
  }

  const completedAt = formatISO(new Date());
  const mergedAudit = mergeAuditCounts(succeeded.map((res) => res.audit));

  const metadata: DockerMetadata = {
    startedAt,
    completedAt,
    summary: {
      total: images.length,
      succeeded: succeeded.length,
      failed: failed.length,
    },
    audit: mergedAudit,
    packages: succeeded.map((res) => res.metadata),
    failedPackages: failed.map((res) => ({ name: res.name, version: res.version, error: res.error })),
  };

  const archivePath = join(OUTPUT_DIR, `${jobId}.tgz`);
  await new Promise<void>((resolveZip, rejectZip) => {
    const output = createWriteStream(archivePath);
    const archive = archiver("tar", { gzip: true });

    output.on("close", resolveZip);
    archive.on("error", rejectZip);
    archive.pipe(output);

    archive.append(JSON.stringify(metadata, null, 2), { name: "metadata.json" });
    for (const result of succeeded) {
      archive.file(result.tarPath, { name: result.metadata.tarball });
    }

    archive.finalize();
  });

  // Remove individual tar files now that they are bundled
  for (const result of succeeded) {
    try {
      unlinkSync(result.tarPath);
    } catch {
      // best-effort cleanup
    }
  }
}
