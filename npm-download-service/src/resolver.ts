import semver from "semver";

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exec, execFile } from "child_process";
import { promisify } from "util";

import { AuditReport, AuditSeverityCounts, PackageJson, ResolvedPackage, ResolverResult } from "./types";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export async function resolveAllDependencies(packageJsonPath: string): Promise<ResolverResult> {
  const raw = readFileSync(packageJsonPath, "utf-8");
  const parsed: PackageJson = JSON.parse(raw);

  const merged: Record<string, string> = {
    ...parsed.dependencies,
    ...parsed.devDependencies,
  };

  if (parsed.peerDependencies) {
    console.log("Resolving peer dependencies...");
    for (const [name, versionSpec] of Object.entries(parsed.peerDependencies)) {
      if (name in merged) continue;

      const needsResolution = versionSpec.includes("||") || /[><=]/.test(versionSpec);
      if (needsResolution) {
        const resolved = await resolveVersionRange(name, versionSpec);
        if (resolved) {
          merged[name] = resolved;
          console.log(`  Resolved peer dep ${name}: "${versionSpec}" → ${resolved}`);
        } else {
          console.warn(`  Could not resolve peer dep ${name}@${versionSpec} — skipping`);
        }
      } else {
        merged[name] = versionSpec;
      }
    }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "npm-resolver-"));

  try {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "resolver-tmp", version: "1.0.0", dependencies: merged }, null, 2),
    );

    console.log("Installing dependencies to resolve full tree...");
    await execAsync("npm install --ignore-scripts --no-audit --no-fund", { cwd: tmpDir });

    const seen = new Set<string>();
    const results: ResolvedPackage[] = [];

    function walkNodeModules(nodeModulesDir: string): void {
      if (!existsSync(nodeModulesDir)) return;

      for (const entry of readdirSync(nodeModulesDir)) {
        const entryPath = join(nodeModulesDir, entry);

        if (entry.startsWith("@")) {
          // Scoped package — walk one level deeper
          if (statSync(entryPath).isDirectory()) {
            for (const scoped of readdirSync(entryPath)) {
              collectPackage(join(entryPath, scoped));
            }
          }
        } else if (!entry.startsWith(".")) {
          collectPackage(entryPath);
        }
      }
    }

    function collectPackage(pkgDir: string): void {
      if (!statSync(pkgDir).isDirectory()) return;

      const pkgJsonPath = join(pkgDir, "package.json");
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
          const key = `${pkg.name}@${pkg.version}`;
          if (pkg.name && pkg.version && !seen.has(key)) {
            seen.add(key);
            results.push({ name: pkg.name, version: pkg.version });
          }
        } catch {
          // skip malformed package.json
        }
      }

      // Recurse into nested node_modules (edge cases)
      const nested = join(pkgDir, "node_modules");
      if (existsSync(nested)) {
        walkNodeModules(nested);
      }
    }

    walkNodeModules(join(tmpDir, "node_modules"));

    const lockfilePath = join(tmpDir, "package-lock.json");
    if (existsSync(lockfilePath)) {
      const lockfile = JSON.parse(readFileSync(lockfilePath, "utf-8")) as PackageLock;
      for (const [modulePath, entry] of Object.entries(lockfile.packages ?? {})) {
        if ((!entry.optional && !entry.peer) || !entry.version) continue;
        if (modulePath.split("node_modules/").length > 2) continue;
        const name = modulePath.replace(/^node_modules\//, "");
        const key = `${name}@${entry.version}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ name, version: entry.version });
        }
      }
    }

    console.log("Running vulnerability audit...");
    const audit = await runAudit(tmpDir, results);
    return { packages: results, audit };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface PackageLock {
  packages?: Record<string, { version?: string; optional?: boolean; peer?: boolean }>;
}

interface NpmAuditJson {
  vulnerabilities?: Record<string, { name: string; severity: string }>;
  metadata?: { vulnerabilities: AuditSeverityCounts };
}

async function runAudit(cwd: string, resolvedPackages: ResolvedPackage[]): Promise<AuditReport> {
  let rawJson: string;
  try {
    const { stdout } = await execAsync("npm audit --json", {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    rawJson = stdout;
  } catch (err: unknown) {
    // npm audit exits code 1 when vulnerabilities are found — stdout is still valid JSON
    const e = err as { stdout?: string };
    if (!e.stdout) {
      console.warn("  npm audit failed to execute — skipping");
      return emptyAuditReport();
    }
    rawJson = e.stdout;
  }

  try {
    const parsed = JSON.parse(rawJson) as NpmAuditJson;
    const severities: AuditSeverityCounts = parsed.metadata?.vulnerabilities ?? {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    };

    const versionMap = new Map(resolvedPackages.map((p) => [p.name, p.version]));
    const highPackages: AuditReport["highPackages"] = [];
    const criticalPackages: AuditReport["criticalPackages"] = [];

    for (const [name, vuln] of Object.entries(parsed.vulnerabilities ?? {})) {
      const version = versionMap.get(name) ?? "unknown";
      if (vuln.severity === "high") highPackages.push({ name, version });
      if (vuln.severity === "critical") criticalPackages.push({ name, version });
    }

    return { severities, highPackages, criticalPackages };
  } catch {
    console.warn("  Failed to parse npm audit output — skipping");
    return emptyAuditReport();
  }
}

export async function resolveVersionRange(packageName: string, versionRange: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", packageName, "versions", "--json"], { maxBuffer: 10 * 1024 * 1024 });
    const versions: string[] = JSON.parse(stdout);
    return semver.maxSatisfying(versions, versionRange);
  } catch {
    return null;
  }
}

function emptyAuditReport(): AuditReport {
  return {
    severities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
    highPackages: [],
    criticalPackages: [],
  };
}
