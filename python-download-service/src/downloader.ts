import archiver from "archiver";
import { formatISO } from "date-fns";
import pLimit from "p-limit";

import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { AuditSeverityCounts, DownloadTarget, FailedTarget, PythonMetadata, PythonPayload } from "./types";
import { resolveTargets } from "./resolver";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

interface PipAuditDependency {
  name: string;
  version: string;
  vulns: Array<{ id: string; fix_versions: string[]; description: string; aliases: string[]; severity?: string }>;
}

interface PipAuditOutput {
  dependencies: PipAuditDependency[];
}

export async function downloadAndBundle(id: string, payload: PythonPayload): Promise<void> {
  const outputDir = resolve("output");
  mkdirSync(outputDir, { recursive: true });

  const tmpRoot = mkdtempSync(join(tmpdir(), `pip-download-${id}-`));
  const requirementsPath = join(tmpRoot, "requirements.txt");
  const mergedDir = join(tmpRoot, "merged");
  mkdirSync(mergedDir);

  const startedAt = formatISO(new Date());

  try {
    const allDeps: Record<string, string> = {
      ...(payload.requirements ?? {}),
      ...(payload.devRequirements ?? {}),
    };

    const requirementsLines = Object.entries(allDeps).map(([name, versionSpec]) =>
      versionSpec === "*" || versionSpec === "" ? name : `${name}${versionSpec}`,
    );
    writeFileSync(requirementsPath, requirementsLines.join("\n") + "\n");

    const targets = resolveTargets(payload);
    const failedTargets: FailedTarget[] = [];
    let succeededTargets = 0;

    const limit = pLimit(4);
    const targetResults = await Promise.allSettled(
      targets.map((target) =>
        limit(async () => {
          const targetDir = join(tmpRoot, `${target.platform}-${target.pythonVersion}`);
          mkdirSync(targetDir);

          const pythonMajorMinor = target.pythonVersion.replace(".", "");
          const abiTag = `cp${pythonMajorMinor}`;

          await execFileAsync(
            "pip3",
            [
              "download",
              "-r",
              requirementsPath,
              "--only-binary",
              ":all:",
              "--platform",
              target.platform,
              "--python-version",
              target.pythonVersion,
              "--implementation",
              "cp",
              "--abi",
              abiTag,
              "--dest",
              targetDir,
            ],
            { timeout: 300_000 },
          );

          return { target, targetDir };
        }),
      ),
    );

    for (let index = 0; index < targetResults.length; index++) {
      const result = targetResults[index];
      const target = targets[index];

      if (result.status === "fulfilled") {
        const { targetDir } = result.value;
        mergeIntoDir(targetDir, mergedDir);
        succeededTargets++;
        logger.log(`  ✓ ${target.platform} / Python ${target.pythonVersion}`);
      } else {
        const rawMessage =
          result.reason instanceof Error ? result.reason.message.split("\n")[0] : String(result.reason);
        const errorMessage = rawMessage.replace(/\/[^\s,]+|[A-Z]:\\[^\s,]+/g, "<path>").slice(0, 200);
        failedTargets.push({ platform: target.platform, pythonVersion: target.pythonVersion, error: errorMessage });
        logger.error(`  ✗ ${target.platform} / Python ${target.pythonVersion} — ${errorMessage}`);
      }
    }

    logger.log(`\nDownloaded ${succeededTargets}/${targets.length} targets (${failedTargets.length} failed)`);

    const audit = await runPipAudit(requirementsPath);
    const files = readdirSync(mergedDir);

    const metadata: PythonMetadata = {
      startedAt,
      completedAt: formatISO(new Date()),
      summary: {
        totalTargets: targets.length,
        succeededTargets,
        failedTargets: failedTargets.length,
      },
      files,
      failedTargets,
      audit,
    };

    const tgzPath = join(outputDir, `${id}.tgz`);
    await createTgz(mergedDir, metadata, tgzPath);
    logger.log(`→ ${tgzPath}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function mergeIntoDir(sourceDir: string, destDir: string): void {
  for (const filename of readdirSync(sourceDir)) {
    try {
      renameSync(join(sourceDir, filename), join(destDir, filename));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

async function runPipAudit(requirementsPath: string): Promise<AuditSeverityCounts> {
  const zeroCounts: AuditSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

  try {
    const { stdout } = await execFileAsync("pip-audit", ["-r", requirementsPath, "--format", "json"], { timeout: 60_000 }).catch(
      (err: unknown) => {
        if (err instanceof Error && "stdout" in err) {
          return { stdout: (err as NodeJS.ErrnoException & { stdout: string }).stdout };
        }
        throw err;
      },
    );

    const output = JSON.parse(stdout) as PipAuditOutput;
    const counts = { ...zeroCounts };

    for (const dep of output.dependencies) {
      for (const vuln of dep.vulns) {
        const severity = (vuln.severity ?? "unknown").toLowerCase();
        if (severity === "critical") counts.critical++;
        else if (severity === "high") counts.high++;
        else if (severity === "medium") counts.medium++;
        else if (severity === "low") counts.low++;
        else counts.unknown++;
      }
    }

    return counts;
  } catch (err) {
    logger.warn("pip-audit failed, skipping audit:", err instanceof Error ? err.message : err);
    return zeroCounts;
  }
}

function createTgz(sourceDir: string, metadata: PythonMetadata, tgzPath: string): Promise<void> {
  return new Promise((resolveZip, rejectZip) => {
    const output = createWriteStream(tgzPath);
    const archive = archiver("tar", { gzip: true, gzipOptions: { level: 6 } });

    output.on("close", resolveZip);
    archive.on("error", rejectZip);

    archive.pipe(output);

    for (const filename of readdirSync(sourceDir)) {
      archive.file(join(sourceDir, filename), { name: filename });
    }

    archive.append(JSON.stringify(metadata, null, 2), { name: "metadata.json" });

    archive.finalize();
  });
}
