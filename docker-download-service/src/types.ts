export interface DockerPayload {
  images: string[];
  platform?: string;
}

export interface ResolvedImage {
  name: string;
  tag: string;
  platform: string;
}

export interface AuditSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface ImageMetadata {
  name: string;
  version: string;
  tarball: string;
  digest?: string;
}

export interface DockerMetadata {
  startedAt: string;
  completedAt: string;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
  };
  audit: AuditSeverityCounts;
  packages: ImageMetadata[];
  failedPackages: Array<{
    name: string;
    version: string;
    error?: string;
  }>;
}
