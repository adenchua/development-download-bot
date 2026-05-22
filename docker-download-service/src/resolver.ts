import { DockerPayload, ResolvedImage } from "./types";

const DEFAULT_PLATFORM = "linux/amd64";

// Docker image names: optional org/name, lowercase alphanum + ._-, optional :tag
const DOCKER_IMAGE_REGEX = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?::[a-zA-Z0-9][a-zA-Z0-9._+\-]*)?$/;

function validateImageName(image: string): boolean {
  return image.length <= 128 && DOCKER_IMAGE_REGEX.test(image);
}

// Parses "name:tag" into { name, tag }, defaulting tag to "latest".
function parseImageRef(imageRef: string): { name: string; tag: string } {
  const colonIndex = imageRef.lastIndexOf(":");
  // A colon before any slash indicates it's part of a hostname, not a tag separator.
  const slashIndex = imageRef.indexOf("/");
  if (colonIndex === -1 || (slashIndex !== -1 && colonIndex < slashIndex)) {
    return { name: imageRef, tag: "latest" };
  }
  return { name: imageRef.slice(0, colonIndex), tag: imageRef.slice(colonIndex + 1) };
}

export interface ResolverResult {
  images: ResolvedImage[];
}

export function resolveImages(payload: DockerPayload): ResolverResult {
  const platform = payload.platform ?? DEFAULT_PLATFORM;
  const seen = new Set<string>();
  const images: ResolvedImage[] = [];

  for (const imageRef of payload.images) {
    if (!validateImageName(imageRef)) {
      throw new Error(`Invalid image name: "${imageRef}"`);
    }
    const { name, tag } = parseImageRef(imageRef);
    const key = `${name}:${tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push({ name, tag, platform });
  }

  return { images };
}
