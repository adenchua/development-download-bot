import { DownloadTarget, PythonPayload } from "./types";

export const ALLOWED_PLATFORMS = [
  "linux_x86_64",
  "linux_aarch64",
  "win_amd64",
  "win32",
  "macosx_14_0_arm64",
  "macosx_12_0_x86_64",
];

export const ALLOWED_PYTHON_VERSIONS = ["3.10", "3.11", "3.12", "3.13"];

export const DEFAULT_PLATFORMS = ["linux_x86_64", "win_amd64"];
export const DEFAULT_PYTHON_VERSIONS = ["3.11", "3.12"];

export const MAX_PACKAGES = 500;

// PEP 508 package name: starts and ends with alphanumeric, allows ._- in the middle
export const PYTHON_PACKAGE_NAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

// PEP 440 version specifier: allows digits, letters (pre-release labels), .  *  ,  =  >  <  !  ~  and spaces only.
// Excludes newlines, semicolons, @, --, and other characters that pip interprets as options or extras.
export const PYTHON_VERSION_SPEC_REGEX = /^[a-zA-Z0-9.*,=<>!~\s]+$/;

export function validatePayload(payload: PythonPayload): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Request body must be a JSON object";
  }

  if (!payload.requirements && !payload.devRequirements) {
    return "Payload must contain at least one of: requirements, devRequirements";
  }

  let totalPackages = 0;

  for (const field of ["requirements", "devRequirements"] as const) {
    const deps = payload[field];
    if (deps === undefined) continue;

    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
      return `"${field}" must be an object`;
    }

    for (const [pkgName, pkgVersion] of Object.entries(deps)) {
      if (!PYTHON_PACKAGE_NAME_REGEX.test(pkgName)) {
        return `Invalid package name in "${field}": "${pkgName}"`;
      }
      if (typeof pkgVersion !== "string") {
        return `All values in "${field}" must be strings`;
      }
      if (pkgVersion !== "*" && pkgVersion !== "" && !PYTHON_VERSION_SPEC_REGEX.test(pkgVersion)) {
        return `Invalid version spec in "${field}" for "${pkgName}": "${pkgVersion}"`;
      }
      totalPackages++;
    }
  }

  if (totalPackages > MAX_PACKAGES) {
    return `Too many packages: ${totalPackages} (max ${MAX_PACKAGES})`;
  }

  if (payload.platforms !== undefined) {
    if (!Array.isArray(payload.platforms)) {
      return '"platforms" must be an array';
    }
    for (const platform of payload.platforms) {
      if (!ALLOWED_PLATFORMS.includes(platform)) {
        return `Invalid platform: "${platform}". Allowed: ${ALLOWED_PLATFORMS.join(", ")}`;
      }
    }
    if (payload.platforms.length === 0) {
      return '"platforms" must not be empty';
    }
  }

  if (payload.pythonVersions !== undefined) {
    if (!Array.isArray(payload.pythonVersions)) {
      return '"pythonVersions" must be an array';
    }
    for (const version of payload.pythonVersions) {
      if (!ALLOWED_PYTHON_VERSIONS.includes(version)) {
        return `Invalid Python version: "${version}". Allowed: ${ALLOWED_PYTHON_VERSIONS.join(", ")}`;
      }
    }
    if (payload.pythonVersions.length === 0) {
      return '"pythonVersions" must not be empty';
    }
  }

  return null;
}

export function resolveTargets(payload: PythonPayload): DownloadTarget[] {
  const platforms = payload.platforms ?? DEFAULT_PLATFORMS;
  const pythonVersions = payload.pythonVersions ?? DEFAULT_PYTHON_VERSIONS;

  const targets: DownloadTarget[] = [];
  for (const platform of platforms) {
    for (const pythonVersion of pythonVersions) {
      targets.push({ platform, pythonVersion });
    }
  }
  return targets;
}
