import semver from "semver";

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { exec, execFile } from "child_process";
import { promisify } from "util";

import { AuditReport, AuditSeverityCounts, PackageJson, ResolvedPackage, ResolverResult } from "./types";
import { logger } from "./logger";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export async function resolveAllDependencies(packageJsonPath: string): Promise<ResolverResult> {
  const raw = readFileSync(packageJsonPath, "utf-8");
  const parsed = JSON.parse(raw) as PackageJson;

  const merged: Record<string, string> = {
    ...parsed.dependencies,
    ...parsed.devDependencies,
  };

  if (parsed.peerDependencies) {
    logger.log("Resolving peer dependencies...");
    for (const [name, versionSpec] of Object.entries(parsed.peerDependencies)) {
      if (name in merged) continue;

      const needsResolution = versionSpec.includes("||") || /[><=]/.test(versionSpec);
      if (needsResolution) {
        const resolved = await resolveVersionRange(name, versionSpec);
        if (resolved) {
          merged[name] = resolved;
          logger.log(`  Resolved peer dep ${name}: "${versionSpec}" → ${resolved}`);
        } else {
          logger.warn(`  Could not resolve peer dep ${name}@${versionSpec} — skipping`);
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

    logger.log("Installing dependencies to resolve full tree...");
    await execAsync("npm install --ignore-scripts --no-audit --no-fund", { cwd: tmpDir, timeout: 600_000 });

    const seen = new Set<string>();
    const results: ResolvedPackage[] = [];

    function addIfNew(name: string, version: string): boolean {
      const key = `${name}@${version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      results.push({ name, version });
      return true;
    }

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
          const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { name?: string; version?: string };
          if (pkg.name && pkg.version) {
            addIfNew(pkg.name, pkg.version);
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

    const lockfilePath = join(tmpDir, "package-lock.json");

    function collectOptionalFromLockfile(): void {
      if (!existsSync(lockfilePath)) return;
      const lockfile = JSON.parse(readFileSync(lockfilePath, "utf-8")) as PackageLock;
      for (const [modulePath, entry] of Object.entries(lockfile.packages ?? {})) {
        if (!entry.optional || !entry.version) continue;
        addIfNew(modulePath.replace(/^node_modules\//, ""), entry.version);
      }
    }

    walkNodeModules(join(tmpDir, "node_modules"));
    collectOptionalFromLockfile();

    // Audit the user's actual dependency tree now, before we expand it with optional peers below,
    // so the report reflects the real project rather than speculatively-added optional peers.
    logger.log("Running vulnerability audit...");
    const audit = await runAudit(tmpDir, results);

    // Discover optional peer dependencies (peerDependenciesMeta.optional). npm does not install
    // these, and npm v11 does not write them to package-lock.json, so scan each installed
    // package.json directly (e.g. vite → esbuild, @types/node; @mui/material → @mui/material-pigment-css).
    const optionalPeerCandidates = new Map<string, string>();
    for (const pkg of [...results]) {
      const pkgDir = join(tmpDir, "node_modules", ...pkg.name.split("/"));
      const pkgJsonPath = join(pkgDir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      try {
        const pkgData = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
          peerDependencies?: Record<string, string>;
          peerDependenciesMeta?: Record<string, { optional?: boolean }>;
        };
        const peerDeps: Record<string, string> = pkgData.peerDependencies ?? {};
        const peerMeta: Record<string, { optional?: boolean }> = pkgData.peerDependenciesMeta ?? {};
        for (const [peerName, peerRange] of Object.entries(peerDeps)) {
          if (peerMeta[peerName]?.optional && !optionalPeerCandidates.has(peerName)) {
            optionalPeerCandidates.set(peerName, peerRange);
          }
        }
      } catch {
        // skip malformed package.json
      }
    }

    // Reinstall with the optional peers added so npm materialises each peer's FULL transitive
    // closure — regular deps AND platform-specific optional deps. A standalone
    // `npm view optionalDependencies` pass cannot do this: it misses regular dependencies like
    // @types/node → undici-types, which then 404 on an offline install. Peers already in `merged`
    // are skipped — the user's tree already resolved them, and re-adding a newer version would
    // pollute the bundle with a version whose own deps were never fetched.
    const peersToInstall: Record<string, string> = {};
    for (const [peerName, peerRange] of optionalPeerCandidates) {
      if (peerName in merged) continue;
      const resolvedVersion = await resolveVersionRange(peerName, peerRange);
      if (resolvedVersion) peersToInstall[peerName] = resolvedVersion;
    }

    const peerNames = Object.keys(peersToInstall);
    if (peerNames.length > 0) {
      logger.log(`Installing ${peerNames.length} optional peer dep(s) to capture their dependencies...`);
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify(
          { name: "resolver-tmp", version: "1.0.0", dependencies: { ...merged, ...peersToInstall } },
          null,
          2,
        ),
      );
      try {
        await execAsync("npm install --ignore-scripts --no-audit --no-fund", { cwd: tmpDir, timeout: 600_000 });
        walkNodeModules(join(tmpDir, "node_modules"));
        collectOptionalFromLockfile();
      } catch (err) {
        const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
        logger.warn(`  Optional peer reinstall failed — bundle may omit optional peer deps: ${message}`);
      }
    }

    return { packages: results, audit };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface PackageLock {
  packages?: Record<string, { version?: string; optional?: boolean }>;
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
      timeout: 120_000,
    });
    rawJson = stdout;
  } catch (err: unknown) {
    // npm audit exits code 1 when vulnerabilities are found — stdout is still valid JSON
    const e = err as { stdout?: string };
    if (!e.stdout) {
      logger.warn("  npm audit failed to execute — skipping");
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
    logger.warn("  Failed to parse npm audit output — skipping");
    return emptyAuditReport();
  }
}

export async function resolveVersionRange(packageName: string, versionRange: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", packageName, "versions", "--json"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    const versions = JSON.parse(stdout) as string[];
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
