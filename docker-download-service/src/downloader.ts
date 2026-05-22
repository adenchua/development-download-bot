import { promisify } from "util";
import { execFile } from "child_process";
import { createWriteStream, unlinkSync } from "fs";
import { join, resolve } from "path";

import archiver from "archiver";
import { formatISO } from "date-fns";

import { ResolvedImage, AuditSeverityCounts, DockerMetadata, ImageMetadata } from "./types";

const execFileAsync = promisify(execFile);

// Naming: "latest" tag gets a short digest suffix; all other tags use tag only.
// Slashes in image names are replaced with dashes (e.g. bitnami/nginx → bitnami-nginx).
function tarballName(name: string, tag: string, shortDigest?: string): string {
  const safeName = name.replace(/\//g, "-");
  if (tag === "latest" && shortDigest) {
    return `${safeName}-latest-${shortDigest}.tar`;
  }
  return `${safeName}-${tag}.tar`;
}

// Returns the first 8 hex chars of the sha256 digest for an image, used to
// make "latest"-tagged filenames unique across pulls at different points in time.
async function getShortDigest(image: ResolvedImage): Promise<string | undefined> {
  try {
    const ref = `${image.name}:${image.tag}`;
    const { stdout } = await execFileAsync("docker", ["inspect", ref, "--format", "{{index .RepoDigests 0}}"]);
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

// Runs trivy against a pulled image and aggregates severity counts.
async function runTrivyScan(imageRef: string): Promise<AuditSeverityCounts> {
  const counts: AuditSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  let stdout = "";
  try {
    const result = await execFileAsync("docker", [
      "run",
      "--rm",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      "trivy-cache:/root/.cache/trivy",
      "aquasec/trivy:latest",
      "image",
      "--format",
      "json",
      "--quiet",
      "--cache-ttl",
      "1h",
      imageRef,
    ]);
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

async function pullAndSave(image: ResolvedImage, outputDir: string): Promise<PullResult> {
  const ref = `${image.name}:${image.tag}`;

  await execFileAsync("docker", ["pull", "--platform", image.platform, ref]);

  let shortDigest: string | undefined;
  if (image.tag === "latest") {
    shortDigest = await getShortDigest(image);
  }

  const filename = tarballName(image.name, image.tag, shortDigest);
  const tarPath = join(outputDir, filename);

  await execFileAsync("docker", ["save", ref, "-o", tarPath]);

  const audit = await runTrivyScan(ref);

  // Clean up pulled image to avoid filling the host's docker storage
  await execFileAsync("docker", ["rmi", ref]).catch(() => {});

  const digest = shortDigest ? `sha256:${shortDigest}` : undefined;
  return {
    status: "fulfilled",
    metadata: { name: image.name, version: image.tag, tarball: filename, digest },
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

  const results = await Promise.allSettled(images.map((image) => pullAndSave(image, TEMP_DIR)));

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
