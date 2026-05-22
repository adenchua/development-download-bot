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

| Condition                            | Status | Error                                            |
| ------------------------------------ | ------ | ------------------------------------------------ |
| Body is not a JSON object            | `400`  | `"Request body must be a JSON object"`           |
| `images` is missing or empty         | `422`  | `'Body must contain a non-empty "images" array'` |
| An entry in `images` is not a string | `422`  | `'All entries in "images" must be strings'`      |

## Output format

Each `output/<id>.tgz` contains one `.tar` file per successfully pulled image, plus `metadata.json`:

```
<id>.tgz
├── metadata.json
├── nginx-latest-a5de3e7a.tar    ← "latest" tags get a short digest suffix
├── redis-7.tar                  ← pinned tags use tag only
└── bitnami-postgresql-16.tar
```

The `.tar` files are produced by `docker save` and can be loaded on the target machine with:

```bash
docker load -i nginx-latest-a5de3e7a.tar
```

### Tarball naming

| Tag              | Example filename                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `latest`         | `nginx-latest-<8-char sha256>.tar` — digest disambiguates pulls at different points in time |
| Any other tag    | `nginx-1.25.tar` — pinned tags are stable so no digest is needed                            |
| Namespaced image | `bitnami-postgresql-16.tar` — `/` replaced with `-`                                         |

### metadata.json

```json
{
  "startedAt": "2026-05-22T14:30:00+08:00",
  "completedAt": "2026-05-22T14:32:10+08:00",
  "summary": { "total": 3, "succeeded": 3, "failed": 0 },
  "audit": { "critical": 0, "high": 2, "medium": 5, "low": 12, "unknown": 0 },
  "packages": [
    { "name": "nginx", "version": "latest", "tarball": "nginx-latest-a5de3e7a.tar", "digest": "sha256:a5de3e7a" },
    { "name": "redis", "version": "7", "tarball": "redis-7.tar" }
  ],
  "failedPackages": [{ "name": "some-private-image", "version": "latest", "error": "pull access denied" }]
}
```

Vulnerability counts come from [Trivy](https://github.com/aquasecurity/trivy), run as an ephemeral `aquasec/trivy:latest` container at scan time. The vulnerability database is cached in a named Docker volume (`trivy-cache`) and refreshed automatically when the cached copy is older than 1 hour.

## Local development

```bash
npm install
npm start       # starts on SERVER_PORT (default 3000)
```

Requires a `.env` file — copy `.env.template` and set `SERVER_PORT` if needed.

**Important:** `docker pull`, `docker save`, `docker inspect`, and the Trivy scan (run as an ephemeral `aquasec/trivy:latest` container) all require a Docker daemon to be accessible. When running locally, the host Docker daemon is used automatically. When running inside a container, `/var/run/docker.sock` must be mounted (see `docker-compose.yml`).

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
5. **Digest** — for `latest`-tagged images, `docker inspect` retrieves the repo digest so the tarball filename encodes which specific version was pulled
6. **Save** — `docker save <image>:<tag> -o <filename>.tar` writes each image to a `.tar` file
7. **Scan** — `docker run --rm aquasec/trivy:latest image --format json --cache-ttl 1h <image>:<tag>` scans each pulled image for vulnerabilities via an ephemeral Trivy container; severity counts are aggregated into `metadata.json`. The vulnerability database is cached in the `trivy-cache` named volume (refreshed when older than 1 hour)
8. **Cleanup** — `docker rmi <image>:<tag>` removes the pulled image from the Docker daemon to avoid filling host storage
9. **Package** — all `.tar` files and `metadata.json` are bundled into `output/<id>.tgz` via `archiver`, then the individual `.tar` files are deleted
