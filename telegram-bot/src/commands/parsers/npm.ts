const NPMJS_URL_REGEX =
  /^https?:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[^/\s]+\/[^/\s]+)|(?:[^@/\s][^/\s]*))(?:\/v\/([^\s/]+))?$/;

// Valid npm package names: lowercase, URL-safe, optional @scope/name format.
const NPM_NAME_REGEX = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
// Valid npm version in a URL context: exact semver or dist-tag (no shell metacharacters).
const NPM_VERSION_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._+\-]*$/;

// Parses and validates a package.json string. Returns a field-allowlisted object
// or null if the input is invalid (unparseable, wrong shape, non-string dep values).
export function parseAndValidatePackageJson(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const pkg = parsed as Record<string, unknown>;
  if (!pkg.dependencies && !pkg.devDependencies && !pkg.peerDependencies) return null;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const val = pkg[field];
    if (val === undefined) continue;
    if (typeof val !== "object" || val === null || Array.isArray(val)) return null;
    if (Object.values(val as object).some((v) => typeof v !== "string")) return null;
  }
  return Object.fromEntries(
    (["name", "version", "dependencies", "devDependencies", "peerDependencies"] as const)
      .filter((key) => pkg[key] !== undefined)
      .map((key) => [key, pkg[key]]),
  );
}

// Returns { name, version } if text is an npmjs.com package URL, else null.
// Query string and fragment are stripped before matching.
// Version defaults to "latest" when no /v/<version> segment is present.
export function parseNpmUrl(text: string): { name: string; version: string } | null {
  const stripped = text.trim().split("?")[0].split("#")[0];
  const match = NPMJS_URL_REGEX.exec(stripped);
  if (!match) return null;
  const name = match[1];
  const version = match[2] ?? "latest";
  if (name.length > 214 || !NPM_NAME_REGEX.test(name)) return null;
  if (version.length > 64 || !NPM_VERSION_REGEX.test(version)) return null;
  return { name, version };
}
