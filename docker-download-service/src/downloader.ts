import { promisify } from "util";
import { execFile } from "child_process";
import { createWriteStream, unlinkSync } from "fs";
import { join, resolve } from "path";

import archiver from "archiver";
import { formatISO } from "date-fns";

import { ResolvedImage, AuditSeverityCounts, DockerMetadata, ImageMetadata } from "./types";

const execFileAsync = promisify(execFile);

const TRIVY_IMAGE = `aquasec/trivy:${process.env.TRIVY_VERSION ?? "latest"}`;
const COPA_IMAGE = `ghcr.io/project-copacetic/copacetic:${process.env.COPA_VERSION ?? "latest"}`;

// Named docker volume shared between the trivy pre-scan and copa: trivy writes
// the JSON report into it via --output, copa reads it via -r. Our service
// itself never touches the volume — the file only crosses container boundaries.
const COPA_REPORT_VOLUME = "copa-reports";
const COPA_REPORT_MOUNT = "/reports";

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
// When reportFilename is given, the JSON report is written into the shared
// copa-reports volume (so copa can consume it) and stdout is empty — counts
// are returned as zero. When reportFilename is unset, trivy streams JSON to
// stdout and counts are parsed for use in metadata.json.
async function runTrivyScan(imageRef: string, reportFilename?: string): Promise<AuditSeverityCounts> {
  const counts: AuditSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

  const dockerArgs: string[] = [
    "run",
    "--rm",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    "trivy-cache:/root/.cache/trivy",
  ];
  if (reportFilename) {
    dockerArgs.push("-v", `${COPA_REPORT_VOLUME}:${COPA_REPORT_MOUNT}`);
  }
  dockerArgs.push(TRIVY_IMAGE, "image", "--format", "json", "--quiet", "--cache-ttl", "1h");
  if (reportFilename) {
    dockerArgs.push("--output", `${COPA_REPORT_MOUNT}/${reportFilename}`);
  }
  dockerArgs.push(imageRef);

  let stdout = "";
  try {
    const result = await execFileAsync("docker", dockerArgs);
    stdout = result.stdout;
  } catch (err: unknown) {
    // trivy exits non-zero when vulnerabilities are found — read stdout anyway
    if (err && typeof err === "object" && "stdout" in err) {
      stdout = (err as { stdout: string }).stdout;
    } else {
      console.error(`[trivy] scan failed for ${imageRef}:`, err);
      return counts;
    }
  }

  // Pre-scan writes to the shared volume; the report is consumed by copa, not us.
  if (reportFilename) return counts;

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
    console.error(`[trivy] failed to parse output for ${imageRef}`);
  }

  return counts;
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
async function runCopaPatch(imageRef: string, reportFilename: string, patchedTag: string): Promise<HardenResult> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "--rm",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${COPA_REPORT_VOLUME}:${COPA_REPORT_MOUNT}`,
      COPA_IMAGE,
      "patch",
      "-i",
      imageRef,
      "-r",
      `${COPA_REPORT_MOUNT}/${reportFilename}`,
      "-t",
      patchedTag,
    ]);
    return {
      hardened: true,
      patchedTag,
      patchedPackageCount: parseCopaPatchedCount(stdout),
    };
  } catch (err: unknown) {
    const stderr =
      err && typeof err === "object" && "stderr" in err ? String((err as { stderr: string }).stderr) : String(err);

    // Copa exits non-zero when the report has no patchable vulnerabilities.
    if (/no.{0,30}(patches|vulnerab|updat)/i.test(stderr)) {
      return { hardened: true, patchedPackageCount: 0 };
    }

    const firstLine = stderr.split("\n").find((line) => line.trim().length > 0) ?? "copa error";
    return { hardened: false, hardenReason: firstLine.trim().slice(0, 200) };
  }
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
  await execFileAsync("docker", ["pull", "--platform", image.platform, originalRef]);

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
  const reportFilename = `${jobId}-${safeName}-${image.tag}.json`;
  const copaTag = `${image.name}:copa-${jobId}`;

  let hardenResult: HardenResult;
  if (image.platform.startsWith("windows/")) {
    hardenResult = { hardened: false, hardenReason: "windows images not supported by copa" };
  } else {
    await runTrivyScan(workingRef, reportFilename);
    hardenResult = await runCopaPatch(workingRef, reportFilename, copaTag);
    if (hardenResult.patchedTag) {
      // Re-tag the patched image as workingRef so docker save / docker load preserve the user-facing tag.
      await execFileAsync("docker", ["tag", hardenResult.patchedTag, workingRef]);
    }
  }

  const finalTag = resolvedTag ?? image.tag;
  const filename = tarballName(image.name, finalTag, shortDigest);
  const tarPath = join(outputDir, filename);

  await execFileAsync("docker", ["save", workingRef, "-o", tarPath]);

  // Post-patch scan — this is the one recorded in metadata.json.audit.
  const audit = await runTrivyScan(workingRef);

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

  const results = await Promise.allSettled(images.map((image) => pullAndSave(image, TEMP_DIR, jobId)));

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
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
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
