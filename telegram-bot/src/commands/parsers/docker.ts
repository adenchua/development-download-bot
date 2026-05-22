// Docker image name: optional org/name prefix, lowercase alphanum + ._-, optional :tag
const DOCKER_IMAGE_REGEX = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?::[a-zA-Z0-9][a-zA-Z0-9._+\-]*)?$/;

// hub.docker.com/_/<image> — official library images
const DOCKER_HUB_OFFICIAL_REGEX = /^https?:\/\/(?:www\.)?hub\.docker\.com\/_\/([a-z0-9][a-z0-9._-]*)(?:\/.*)?$/;
// hub.docker.com/r/<org>/<name> — user/org images
const DOCKER_HUB_USER_REGEX =
  /^https?:\/\/(?:www\.)?hub\.docker\.com\/r\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)(?:\/.*)?$/;

export function validateDockerImageName(image: string): boolean {
  return image.length <= 128 && DOCKER_IMAGE_REGEX.test(image);
}

// Parses a docker JSON payload. Returns { images, platform } or null.
// images must be a non-empty array of valid docker image name strings.
// platform defaults to "linux/amd64" if not provided.
export function parseDockerJson(text: string): { images: string[]; platform: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.images) || obj.images.length === 0) return null;
  for (const image of obj.images) {
    if (typeof image !== "string" || !validateDockerImageName(image)) return null;
  }
  const platform = typeof obj.platform === "string" ? obj.platform : "linux/amd64";
  return { images: obj.images as string[], platform };
}

// Returns { images, platform } if text is a Docker Hub URL, else null.
// Query strings and fragments are stripped before matching.
// Tag defaults to "latest" since Hub URLs don't carry tag information.
export function parseDockerHubUrl(text: string): { images: string[]; platform: string } | null {
  const stripped = text.trim().split("?")[0].split("#")[0];

  const officialMatch = DOCKER_HUB_OFFICIAL_REGEX.exec(stripped);
  if (officialMatch) {
    const name = officialMatch[1];
    if (!validateDockerImageName(name)) return null;
    return { images: [`${name}:latest`], platform: "linux/amd64" };
  }

  const userMatch = DOCKER_HUB_USER_REGEX.exec(stripped);
  if (userMatch) {
    const org = userMatch[1];
    const name = userMatch[2];
    const image = `${org}/${name}`;
    if (!validateDockerImageName(image)) return null;
    return { images: [`${image}:latest`], platform: "linux/amd64" };
  }

  return null;
}
