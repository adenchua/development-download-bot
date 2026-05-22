# docker-download-service

An HTTP service that pulls Docker images and packages them as self-contained `.tgz` archives for offline use. Useful for air-gapped environments that need pre-pulled images loaded via `docker load`.

## API endpoints

| Method | Path                    | Description                                                  |
| ------ | ----------------------- | ------------------------------------------------------------ |
| `GET`  | `/health`               | Health check; returns `{ status, timestamp }`                |
| `POST` | `/upload`               | Upload a docker payload body; returns `{ id }`               |
| `GET`  | `/files`                | List all uploaded files with metadata                        |
| `GET`  | `/files?showToday=true` | List only files uploaded today (local time)                  |
| `POST` | `/jobs`                 | Start a download job; body `{ id }`; returns 202 immediately |
| `GET`  | `/docs`                 | Interactive API documentation (Swagger UI)                   |

## Typical workflow

**1. Upload a docker payload:**

```bash
curl -X POST http://localhost:3000/upload \
  -H 'Content-Type: application/json' \
  -d '{ "images": ["nginx:latest", "redis:7"] }'
# → { "id": "20260522-1430-1" }
```

**2. Trigger a download job:**

```bash
curl -X POST http://localhost:3000/jobs \
  -H 'Content-Type: application/json' \
  -d '{ "id": "20260522-1430-1" }'
# → 202 Accepted; job runs in the background
```

**3. Collect output** — the `.tgz` archive appears in `output/<id>.tgz` when the job completes.

## Input format

A JSON body with a non-empty `images` array and an optional `platform` field:

```json
{
  "images": ["nginx:latest", "redis:7", "bitnami/postgresql:16"],
  "platform": "linux/amd64"
}
```

`platform` defaults to `linux/amd64` if omitted. All images in a single payload are pulled for the same platform.

Image names follow standard Docker naming rules: lowercase alphanumeric plus `._-`, optional `<org>/<name>` namespacing, optional `:<tag>` suffix. Tags default to `latest` when omitted.

### Validation

| Condition                              | Status | Error                                                           |
| -------------------------------------- | ------ | --------------------------------------------------------------- |
| Body is not a JSON object              | `400`  | `"Request body must be a JSON object"`                          |
| `images` is missing or empty           | `422`  | `'Body must contain a non-empty "images" array'`                |
| `images` has more than 20 entries      | `422`  | `"Too many images: N (max 20)"`                                 |
| An entry in `images` is not a valid image name | `422` | `"Invalid image name: \"<name>\""`                    |
| `platform` is not a supported value    | `422`  | `"Unsupported platform: \"<value>\". Allowed: linux/amd64, …"` |

Supported platform values: `linux/amd64`, `linux/arm64`, `linux/arm/v6`, `linux/arm/v7`, `linux/386`, `linux/ppc64le`, `linux/s390x`, `windows/amd64`.

`POST /jobs` additionally validates that `id` matches the format `YYYYMMDD-HHmm-N` before constructing the input file path.

## Output format

Each `output/<id>.tgz` contains one `.tar` file per successfully pulled image, plus `metadata.json`:

```
<id>.tgz
├── metadata.json
├── nginx-1.27.5.tar             ← "latest" resolved to concrete version via OCI label
├── redis-7.tar                  ← pinned tags use tag only
└── bitnami-postgresql-16.tar
```

The `.tar` files are produced by `docker save` and can be loaded on the target machine with:

```bash
docker load -i nginx-1.27.5.tar
```

### Tarball naming

| Tag                              | Example filename                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `latest` (version label present) | `nginx-1.27.5.tar` — resolved to the concrete version via `org.opencontainers.image.version` |
| `latest` (label absent)          | `nginx-latest-<8-char sha256>.tar` — digest disambiguates pulls at different points in time   |
| Any other tag                    | `nginx-1.25.tar` — pinned tags are stable so no digest is needed                             |
| Namespaced image                 | `bitnami-postgresql-16.tar` — `/` replaced with `-`                                          |

When `latest` resolves to a concrete version, the saved image is re-tagged to that version before saving. Loading the archive on the target machine gives you the properly versioned tag (e.g. `nginx:1.27.5`) rather than `nginx:latest`.

### metadata.json

```json
{
  "startedAt": "2026-05-22T14:30:00+08:00",
  "completedAt": "2026-05-22T14:32:10+08:00",
  "summary": { "total": 3, "succeeded": 3, "failed": 0 },
  "audit": { "critical": 0, "high": 2, "medium": 5, "low": 12, "unknown": 0 },
  "packages": [
    { "name": "nginx", "version": "1.27.5", "tarball": "nginx-1.27.5.tar", "hardened": true, "patchedPackageCount": 12 },
    { "name": "redis", "version": "7", "tarball": "redis-7.tar", "hardened": true, "patchedPackageCount": 0 }
  ],
  "failedPackages": [{ "name": "some-private-image", "version": "latest", "error": "pull access denied" }]
}
```

When `latest` cannot be resolved (label absent), the entry falls back to `"version": "latest"` with a `"digest"` field: `{ "name": "nginx", "version": "latest", "tarball": "nginx-latest-a5de3e7a.tar", "digest": "sha256:a5de3e7a", "hardened": true, "patchedPackageCount": 12 }`.

Vulnerability counts come from [Trivy](https://github.com/aquasecurity/trivy), run as an ephemeral `aquasec/trivy` container at scan time. The version tag is controlled by the `TRIVY_VERSION` env var (default: `latest`); set it to a specific version (e.g. `0.62.0`) in `.env` for reproducible scans. The vulnerability database is cached in a named Docker volume (`trivy-cache`) and refreshed automatically when the cached copy is older than 1 hour.

### Hardening (Copa)

Every image in the bundle is run through [Copacetic (`copa`)](https://github.com/project-copacetic/copacetic) before being saved. Copa reads a Trivy report and patches only the OS packages that have known CVEs (it does not touch app-level packages, e.g. npm modules or Python wheels inside the image). The result: bundled images ship pre-patched, with the **same** tag they were pulled under — `docker load -i nginx-1.27.5.tar` still gives you `nginx:1.27.5`, just with patched OS packages.

The `audit` counts in `metadata.json` reflect the **post-patch** state — i.e. the residual CVEs after Copa has done its work, not the original upstream state.

Each entry in `packages[]` carries:

| Field                 | Meaning                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `hardened`            | `true` if Copa ran successfully (including the no-op case). `false` if Copa errored or was skipped.       |
| `patchedPackageCount` | Number of packages Copa patched (parsed from its stdout). `0` if no CVEs were patchable. Omitted on fail. |
| `hardenReason`        | Short reason string when `hardened: false` (e.g. `"windows images not supported by copa"`). Otherwise omitted. |

The Copa container version is pinned via `COPA_VERSION` in `.env` (default: `latest`). Set it to a specific tag (e.g. `0.9.0`) for reproducibility. Copa requires the host Docker daemon to support BuildKit (Docker 23+), which is the default on modern installations.

Trivy is run **twice** per image: once as a throwaway pre-scan to produce the JSON report that Copa consumes (written into a shared named volume `copa-reports`), and once after Copa patches to produce the audit counts recorded in `metadata.json`. The Trivy database cache (`trivy-cache` volume) is shared between both invocations, so the second run is fast.

If Copa cannot patch an image (Copa errors on an unsupported OS, Windows containers, etc.), the original unpatched image is saved instead and `hardened: false` is recorded with a reason — the job still succeeds.

## Local development

```bash
npm install
npm start       # starts on SERVER_PORT (default 3000)
```

Requires a `.env` file — copy `.env.template` and set `SERVER_PORT` if needed.

**Important:** `docker pull`, `docker save`, `docker inspect`, the Trivy scan (run as an ephemeral `aquasec/trivy` container), and the Copa hardening step (run as an ephemeral `ghcr.io/project-copacetic/copacetic` container) all require a Docker daemon to be accessible. Copa additionally requires Docker 23+ on the host so that BuildKit is available through the daemon. When running locally, the host Docker daemon is used automatically. When running inside a container, `/var/run/docker.sock` must be mounted (see `docker-compose.yml`).

## Scripts

| Command         | Description                                |
| --------------- | ------------------------------------------ |
| `npm start`     | Start HTTP server (no build step required) |
| `npm run dev`   | Start with file watching                   |
| `npm run build` | Compile TypeScript to `dist/`              |

## How it works

1. **Upload** — `POST /upload` validates the payload, fills in the default platform (`linux/amd64`), saves to `input/<id>.json`, and returns the ID
2. **Trigger** — `POST /jobs` starts a background job for that ID; responds 202 immediately
3. **Resolve** — `resolver.ts` validates each image name (rejects shell metacharacters), deduplicates by `name:tag`, and returns the normalised list
4. **Pull** — `docker pull --platform <platform> <image>:<tag>` is run concurrently for all images via `Promise.allSettled` (partial success — failed images are recorded but don't abort the job)
5. **Resolve latest** — for `latest`-tagged images, `docker inspect` reads the `org.opencontainers.image.version` OCI label; if present, the image is re-tagged to that version (e.g. `nginx:1.27.5`) and saved under the concrete tag. If the label is absent, the repo digest is used as a filename suffix instead (`nginx-latest-a5de3e7a.tar`)
6. **Pre-scan** — `trivy image --format json --output /reports/<file>.json <image>:<tag>` writes a vulnerability report into the shared `copa-reports` named volume. Windows images skip this step.
7. **Harden** — `copa patch -i <image>:<tag> -r /reports/<file>.json -t <patched-tag>` produces a patched image using BuildKit on the host Docker daemon. The patched image is then `docker tag`'d back to the user-facing tag. On Copa error, the original image proceeds unchanged and `hardened: false` is recorded.
8. **Save** — `docker save <image>:<tag> -o <filename>.tar` writes each (patched-or-original) image to a `.tar` file
9. **Post-scan** — Trivy runs again to capture the post-patch CVE counts that are written to `metadata.json.audit`
10. **Cleanup** — `docker rmi <image>:<tag>` removes the pulled image(s) and the copa-tagged variant from the Docker daemon to avoid filling host storage
11. **Package** — all `.tar` files and `metadata.json` are bundled into `output/<id>.tgz` via `archiver`, then the individual `.tar` files are deleted
