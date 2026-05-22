# CLAUDE.md — npm-download-bot

## Repository layout

| Directory | Role |
|-----------|------|
| `npm-download-service/` | HTTP service that resolves and bundles npm dependencies as offline `.tgz` archives |
| `docker-download-service/` | HTTP service that pulls Docker images and bundles them as offline `.tgz` archives |
| `telegram-bot/` | Telegram bot for submitting download requests and managing user access |
| `database/` | MongoDB schema definitions and init scripts |

> **Future:** `python-download-service/` — will follow the same HTTP contract (`POST /upload` → `{ id }`, `POST /jobs`) and service structure as the existing services. The bot already has parser stubs in `telegram-bot/src/commands/parsers/` for npm and docker; a `python.ts` parser will be added when that service is built.

## Development commands

All three services (`npm-download-service`, `docker-download-service`, `telegram-bot`) share the same scripts (run from the relevant package directory):

| Command | Description |
|---------|-------------|
| `npm start` | Run with `tsx` — no build step; requires a populated `.env` |
| `npm run dev` | Same as `start` but restarts on file changes |
| `npm run build` | Compile TypeScript to `dist/` via `tsc` |
| `npm run format` | Reformat all `src/**/*.{ts,js}` with Prettier |

## Docker Compose

Five services with explicit health-check dependencies:

```
npm-download-service    (health: GET /health)
docker-download-service (health: GET /health)
mongodb                 (health: mongosh ping)   ← initialised by database/init/01-init.js on first run
  └── telegram-bot      (depends on mongodb + npm-download-service + docker-download-service, all healthy)
  └── mongo-express     (depends on mongodb, healthy)
```

Volume mounts:
- `npm-download-service/input/` and `output/` → `/app/input` and `/app/output`
- `docker-download-service/input/` and `output/` → `/app/input` and `/app/output`
- `/var/run/docker.sock` → `/var/run/docker.sock` (docker-download-service needs host Docker daemon access)
- `database/data/` → `/data/db` (MongoDB persistence)
- `database/init/` → `/docker-entrypoint-initdb.d/` (runs once on init)
- `database/schemas/` → `/schemas/` (read by init script)

`NPM_DOWNLOAD_SERVICE_URL` and `DOCKER_DOWNLOAD_SERVICE_URL` are injected directly via `environment:` in the compose file so the telegram-bot always resolves to the correct internal hostnames, regardless of what is in `telegram-bot/.env`.

## npm-download-service source map

| File | Role |
|------|------|
| `npm-download-service/src/index.ts` | HTTP server entry point; creates `input/` and `output/` dirs, starts Express on `SERVER_PORT` |
| `npm-download-service/src/app.ts` | Express app factory; mounts `filesRouter`, `resolveRouter`, and `jobsRouter`; serves Swagger UI at `GET /docs` via `swagger-ui-express`; registers global `errorHandler`; sets explicit `express.json({ limit: "100kb" })` body size cap |
| `npm-download-service/src/swagger.ts` | OpenAPI 3.1.0 document exported as `swaggerDocument`; defines all paths and reusable schemas in `components/schemas` |
| `npm-download-service/src/routes/files.ts` | `POST /upload` and `GET /files` (with `?showToday` filter); upload validates dep field keys against `NPM_PACKAGE_NAME_REGEX`, caps each field at `MAX_DEPS_PER_FIELD` (500 entries), and validates values are strings |
| `npm-download-service/src/routes/jobs.ts` | `POST /jobs` — fire-and-forget download job; validates `id` matches `/^\d{8}-\d{4}-\d+$/` before using it in a path join |
| `npm-download-service/src/middleware/errorHandler.ts` | Global Express error handler |
| `npm-download-service/src/resolver.ts` | Creates a temp dir, merges `dependencies`/`devDependencies`/`peerDependencies`, runs `npm install` to materialise the full dependency tree, walks `node_modules`, then runs three passes to collect packages npm skipped: (a) lockfile scan for `optional: true` entries (platform-specific optional deps); (b) per-package `peerDependencies`+`peerDependenciesMeta` scan for optional peer deps npm v11 omits from the lockfile (e.g. `@mui/material-pigment-css`, `esbuild`); (c) `npm view optionalDependencies` for each pass-(b) addition to catch their platform packages (e.g. all `@esbuild/*` when `esbuild` was never installed). `addIfNew(name, version)` inner helper deduplicates across all passes. Complex peer dep version ranges (`\|\|`, comparisons) are resolved to a concrete latest version via `semver.maxSatisfying()` before install. Runs `npm audit` after collection. |
| `npm-download-service/src/downloader.ts` | Concurrently runs `npm pack <name>@<version>` for all resolved packages via `Promise.allSettled`, collects results (succeeded/failed), bundles all tarballs + `metadata.json` into a `.tgz` via `archiver` |
| `npm-download-service/src/types.ts` | All shared TypeScript interfaces (`PackageJson`, `ResolvedPackage`, `AuditReport`, `PackageMetadata`, etc.) |

## telegram-bot source map

| File | Role |
|------|------|
| `telegram-bot/src/index.ts` | Bot entry point; registers middleware (session → cancel → stage), all command handlers, `bot.on('message')` passive handler (detects npm/docker inputs silently), startup DB index creation and env var validation (`NPM_DOWNLOAD_SERVICE_URL` + `DOCKER_DOWNLOAD_SERVICE_URL` both required) |
| `telegram-bot/src/db/index.ts` | MongoDB connection management (`connectDb`, `getDb`, `closeDb`) |
| `telegram-bot/src/db/clients.ts` | `clients` collection: `registerClient`, `approveClient`, `grantAdmin`, `getClientByTelegramId`, `getClientById`, `getPendingClients`, `ensureIndexes` — `Client` interface includes optional `isAdmin` field |
| `telegram-bot/src/db/subscribers.ts` | `subscribers` collection: `addSubscriber`, `removeSubscriber`, `getAllSubscribers`, `ensureIndexes` |
| `telegram-bot/src/db/jobs.ts` | `jobs` collection: `addJob`, `getPendingJobs`, `updateJobStatus`, `getJobByJobId`, `ensureIndexes` — records each download request with `clientId`, `jobId`, `startedAt`, `serviceType` (`"npm"` \| `"docker"`, optional for backwards compat with pre-existing docs); optional `status` (`"success"` \| `"failed"`), `completedAt`, and `completedBy` (Telegram ID of the admin who resolved it) set by `/notify_client`; `getPendingJobs(limit, maxAgeDays?)` accepts an optional `maxAgeDays` — when provided, adds `startedAt: { $gte: now - maxAgeDays * 24h }` to the query |
| `telegram-bot/src/commands/helpers.ts` | Shared helpers: `BotContext`, `getText`, `requireText`, `checkSecret`, `MAX_PACKAGE_JSON_BYTES`, `ALLOWED_MIME_TYPES`, `CALLBACK_PREFIXES`, `formatClientName`, `requireCallbackData`, `SECRET_PROMPT_STEP` — `SECRET_PROMPT_STEP` checks `isAdmin` in DB and bypasses the prompt for known admins; `checkSecret` persists `isAdmin` via `grantAdmin` and auto-subscribes via `addSubscriber` on first successful validation. Service-specific parsers have moved to `commands/parsers/`. |
| `telegram-bot/src/commands/parsers/npm.ts` | npm-specific parsing: `parseAndValidatePackageJson(text)` and `parseNpmUrl(text)` (moved from `helpers.ts`). `parseAndValidatePackageJson` validates a JSON string and returns a field-allowlisted object or `null`. `parseNpmUrl` matches an npmjs.com URL and returns `{ name, version }` with shell-metacharacter validation. |
| `telegram-bot/src/commands/parsers/docker.ts` | Docker-specific parsing: `parseDockerJson(text)` validates a `{ images, platform? }` JSON payload — caps `images` at `MAX_DOCKER_IMAGES` (20) and validates `platform` against `ALLOWED_PLATFORMS`; `parseDockerHubUrl(text)` matches `hub.docker.com/_/<image>` (official) and `hub.docker.com/r/<org>/<name>` (user/org) URLs; both return `{ images, platform }` or `null`. `validateDockerImageName` is the shared image-name validator used by both. Tag defaults to `latest` when not present in the URL. |
| `telegram-bot/src/commands/approveClient.ts` | 4-step wizard: (secret prompt or admin bypass) → validate → show inline keyboard of pending clients → confirm with Yes/No buttons → approve |
| `telegram-bot/src/commands/notifyClient.ts` | 4-step wizard: (secret prompt or admin bypass) → validate → show inline keyboard of last 5 pending jobs from the past 7 days (no `status` field) → select job → Success/Failed buttons → update `status`/`completedAt`/`completedBy` in DB → send outcome message to original requestor. Job labels are prefixed with `[npm]` or `[docker]`; legacy jobs without `serviceType` fall back to `[npm]`. |
| `telegram-bot/src/commands/subscribe.ts` | Two 2-step wizards: `subscribeScene` and `unsubscribeScene` — both use the same admin-bypass step 0 |
| `telegram-bot/src/commands/request.ts` | Multi-service dispatcher: 2-step wizard that auto-detects service type from input and routes to the correct service. Detection order: (1) npmjs.com URL → npm, (2) hub.docker.com URL → docker, (3) JSON with dep fields → npm, (4) JSON with `images` key → docker. Inner `submitJob(ctx, serviceUrl, serviceType, payload)` handles upload → job record → job start → subscriber notification for all service types. Exports `processPackageJsonRequest`, `processNpmUrlRequest`, `processDockerJsonRequest`, and `resolveRawText` — all shared with the passive handler in `index.ts`. |

## docker-download-service source map

| File | Role |
|------|------|
| `docker-download-service/src/index.ts` | HTTP server entry point; creates `input/` and `output/` dirs, starts Express on `SERVER_PORT` |
| `docker-download-service/src/app.ts` | Express app factory; mounts `filesRouter` and `jobsRouter`; serves Swagger UI at `GET /docs`; registers global `errorHandler`; sets explicit `express.json({ limit: "100kb" })` body size cap |
| `docker-download-service/src/swagger.ts` | OpenAPI 3.1.0 document exported as `swaggerDocument` |
| `docker-download-service/src/routes/files.ts` | `POST /upload` — validates image names (via `validateImageName`), caps `images` at `MAX_IMAGES` (20), validates `platform` against `ALLOWED_PLATFORMS`, saves sanitized payload to `input/<id>.json`; `GET /files` (with `?showToday` filter) |
| `docker-download-service/src/routes/jobs.ts` | `POST /jobs` — fire-and-forget download job; validates `id` matches `/^\d{8}-\d{4}-\d+$/` before using it in a path join; reads saved payload, calls `resolveImages` then `downloadAndZip` |
| `docker-download-service/src/middleware/errorHandler.ts` | Global Express error handler |
| `docker-download-service/src/types.ts` | All shared TypeScript interfaces (`DockerPayload`, `ResolvedImage`, `AuditSeverityCounts`, `ImageMetadata`, `DockerMetadata`). `ImageMetadata` carries the per-image hardening fields: `hardened: boolean`, `patchedPackageCount?: number`, `hardenReason?: string`. |
| `docker-download-service/src/resolver.ts` | Exports `validateImageName`, `ALLOWED_PLATFORMS`, and `MAX_IMAGES` (20). `resolveImages` validates platform against `ALLOWED_PLATFORMS`, enforces the image count cap, validates image names (no shell metacharacters, ≤128 chars), deduplicates by `name:tag`, normalises tag (defaults to `latest`), returns `ResolvedImage[]`. No dependency graph — Docker has no transitive deps. |
| `docker-download-service/src/downloader.ts` | Concurrently runs `docker pull --platform <platform> <image>:<tag>` for all images via `Promise.allSettled`. For `latest`-tagged images, tries the OCI version label first, falls back to a short repo-digest filename suffix. Runs a Trivy **pre-scan** that writes the JSON report into the shared `copa-reports` named volume, then runs `copa patch` to produce a hardened image (CVE-driven). Re-tags the patched image to the user-facing tag, `docker save`s it, then runs Trivy a second time to record the post-patch CVE counts in `metadata.json.audit`. Cleans up with `docker rmi`. Bundles all `.tar` files + `metadata.json` into `output/<id>.tgz` via `archiver`. |

## database source map

| File | Role |
|------|------|
| `database/schemas/clients.json` | Collection + unique index definition for `clients` |
| `database/schemas/subscribers.json` | Collection + unique index definition for `subscribers` |
| `database/schemas/jobs.json` | Collection + unique index on `jobId` (name: `job`) + index on `clientId` (name: `jobsByClient`) + descending index on `startedAt` (name: `jobsByDate`) for `jobs` |
| `database/init/01-init.js` | mongosh init script; reads every `*.json` from `/schemas`, creates collections and indexes |

## Architectural decisions

**No single-letter variable names** — Use descriptive names throughout. Single-letter names (e.g. `m`, `p`, `k`) are banned as they are hard to read and debug. For example, use `match` for regex results, `pkg` for package objects, `key` for object keys.

**Prettier for code formatting** — all three services (`npm-download-service`, `docker-download-service`, `telegram-bot`) use Prettier (exact version, pinned in `devDependencies`) with a shared config: `trailingComma: "all"`, `printWidth: 120`, `useTabs: false`, `tabWidth: 2`. Run `npm run format` in any package to reformat all `src/**/*.{ts,js}` files. Config lives in `.prettierrc` at each package root.

**Import ordering** — imports are grouped in three sections, each separated by a blank line: (1) internet/npm packages (e.g. `express`, `telegraf`, `date-fns`), (2) Node.js built-in/library packages (e.g. `fs`, `path`, `os`, `child_process`), (3) project-local imports (e.g. `./app`, `../types`). No `import * as X` wildcard imports for internet or library packages — always use named imports (e.g. `import { readFileSync, writeFileSync } from "fs"`). In `downloader.ts` the Promise executor uses `(resolveZip, rejectZip)` to avoid shadowing the `resolve` named import from `path`.

**tsx instead of ts-node** — no build step needed; `npm start` executes TypeScript directly via esbuild. `npm run build` (tsc → `dist/`) exists for producing a compiled binary but is not required for development.

**HTTP API instead of interactive CLI** — the service exposes a REST API. Upload a `package.json` via `POST /upload`, then trigger a job via `POST /jobs`. The old interactive prompt (`@inquirer/prompts`) has been replaced.

**File stem as archive ID** — uploaded files are saved as `input/<id>.json` where the ID is `yyyyMMdd-HHmm-X` (X = 1-indexed count of `.json` files in `input/` at upload time). This produces `output/<id>.tgz`. No separate manifest file.

**`execFile` (not `exec`) for `npm pack` and `npm view`** — both `downloader.ts` and `resolver.ts` use `execFileAsync = promisify(execFile)` rather than `execAsync = promisify(exec)` for calls that include user-controlled arguments (`npm pack <name>@<version>` and `npm view <packageName> versions --json`). `execFile` bypasses the shell entirely, so package names containing shell metacharacters are passed as literal strings to the npm binary. `npm install` and `npm audit` remain on `execAsync` since their arguments are hardcoded.

**`maxBuffer: 1024 * 1024 * 1024` on `npm pack`** — large packages (e.g. `@mui/icons-material`) emit multi-megabyte stderr (peer dependency warnings). The default 1 MB buffer causes silent failures. Set to 1 GB; only text is buffered, not binary tarballs.

**`--no-audit` on `npm install`, explicit `npm audit --json` after** — `--no-audit` only suppresses the inline install-time report; it does not affect `package-lock.json`. Running `npm audit --json` separately after install reads the lock file and always produces accurate results.

**`date-fns` for local-time timestamps** — all timestamps (`startedAt`, `completedAt`, `uploadedAt`, health check) use `formatISO()` from `date-fns`, which produces local time with UTC offset (e.g. `2026-03-21T10:00:00+08:00`) instead of UTC `Z` strings. The ID prefix uses `format(new Date(), 'yyyyMMdd-HHmm')` for a compact local-time stamp. `telegram-bot` also uses `date-fns` (`format()`) when displaying `registeredAt` timestamps to the admin in the approve-client flow.

**`TZ=Asia/Singapore` in containers** — all three services set `TZ: Asia/Singapore` via `environment:` in `docker-compose.yml`. Without this, Node.js inside the container uses UTC, making all `date-fns` local-time calls produce UTC timestamps and UTC-offset IDs (`+00:00`).

**Schema-driven DB initialisation** — `database/schemas/*.json` are the single source of truth for collection structure. `database/init/01-init.js` reads all JSON files generically on first MongoDB startup; adding a new collection means adding one JSON file with no changes to the init script.

**`$setOnInsert` upsert for idempotent registration** — `registerClient` and `addSubscriber` use `updateOne({ telegramId }, { $setOnInsert: data }, { upsert: true })`. Re-registering returns `upsertedCount === 0` and is a complete no-op in the database; the original document is never overwritten.

**`ensureIndexes()` at startup** — `clients.ts`, `subscribers.ts`, and `jobs.ts` each expose an `ensureIndexes()` function that calls `createIndex` for each required named index. All three are called in `main()` before `bot.launch()`. MongoDB's `createIndex` is idempotent — it is a no-op if the index already exists — so this works correctly whether the DB is fresh or pre-existing. This replaces the old `verifyIndexes` pattern that would refuse to start if indexes were absent.

**`APPROVE_SECRET` as a one-time admin gate** — the secret is read from `process.env.APPROVE_SECRET` once at module load in `commands/helpers.ts`. On first use, admin commands prompt for the secret; on a match, `checkSecret()` calls `grantAdmin()` (upserts `isAdmin: true` and `isApproved: true`, auto-registering the user if needed) and `addSubscriber()` (idempotent — no-op if already subscribed). `SECRET_PROMPT_STEP` checks the DB before every admin command: if `isAdmin` is already set it skips the prompt, sets `ctx.wizard.state.isAdmin = true`, and invokes step 1 directly via `ctx.wizard.selectStep(1)` + `ctx.wizard.step(ctx, next)`. `checkSecret()` short-circuits to `true` when `ctx.wizard.state.isAdmin` is set, so the secret text passed from the command message is never compared.

**`/cancel` middleware ordering** — the cancel command is registered on the bot after `session()` but before `stage.middleware()`. This ensures it intercepts `/cancel` before any active scene's step handlers can consume the message. It reads `ctx.session.__scenes.current` (via the typed `Scenes.WizardSession` cast) to detect whether a scene is active.

**Service-specific parsers in `commands/parsers/`** — npm and docker input parsing live in separate files rather than `helpers.ts`. `parsers/npm.ts` exports `parseAndValidatePackageJson` and `parseNpmUrl`; `parsers/docker.ts` exports `parseDockerJson`, `parseDockerHubUrl`, and `validateDockerImageName`. `helpers.ts` retains only truly shared utilities (`BotContext`, `getText`, `requireText`, `checkSecret`, `requireCallbackData`, `formatClientName`, `CALLBACK_PREFIXES`, `SECRET_PROMPT_STEP`, `MAX_PACKAGE_JSON_BYTES`, `ALLOWED_MIME_TYPES`). When `python-download-service` is built, add `parsers/python.ts` following the same pattern.

**Shared wizard helpers** — `requireCallbackData(ctx, prefix, errorMsg)` validates a callback query, answers it, and returns the data string after the given prefix — or replies with `errorMsg` and returns `null`; used by all inline-keyboard steps in admin scenes. `formatClientName(client)` joins `firstName` and `lastName` filtering out blanks. `CALLBACK_PREFIXES` is a `const` object of all inline-keyboard callback data prefixes (`SELECT_CLIENT`, `CONFIRM_ACTION`, `SELECT_JOB`, `SELECT_OUTCOME`). `SECRET_PROMPT_STEP` is the shared first wizard step used by all admin-gated scenes — replies "Enter the admin secret:" and advances the wizard.

**JSON detection order: npm before docker** — when a message contains a JSON text/file, the bot checks for npm dep fields first (`dependencies`, `devDependencies`, `peerDependencies`). Only if none are present does it check for the `images` key (docker). This prevents a `package.json` that happens to have a custom `images` field from being misrouted to the docker service. URL routing is separate: `npmjs.com` → npm, `hub.docker.com` → docker; these are mutually exclusive so order doesn't matter.

**`serviceType` field in jobs** — the `Job` interface has an optional `serviceType?: "npm" | "docker"` field. It is optional (not required) so that existing DB documents without the field continue to be read correctly. New jobs always pass `serviceType`. `/notify_client` labels use `job.serviceType ?? "npm"` — legacy jobs without the field display as `[npm]`.

**Passive package detection** — `index.ts` registers a `bot.on('message')` handler (after all commands) that automatically processes messages as a `/request` without the user typing a command. It triggers when a registered+approved user sends any document, text starting with `{`, an npmjs.com URL, or a hub.docker.com URL. Before downloading a document, the handler checks `file_size` (>100 KB → silent return) and `mime_type`/file extension against `ALLOWED_MIME_TYPES` (`application/json`, `text/plain`, `text/json`, `application/octet-stream`, `.json`, `.txt`); unrecognised types are silently ignored. After downloading, body length is rechecked as defence-in-depth. JSON input is tried as npm first, then docker (same detection order as the wizard). The upload+job+notify logic lives in `commands/request.ts` (`submitJob` helper), shared with the wizard. The wizard replies with error messages on bad input; the passive handler silently ignores it.

**Three-pass discovery for uninstalled packages** — packages never placed in `node_modules` by `npm install` yet still needed for the offline bundle come in three categories. After `walkNodeModules`, `resolver.ts` runs three passes: (a) reads `package-lock.json` and adds every entry with `optional: true` that is not already in `seen` — catches platform-specific optional deps (e.g. `@esbuild/win32-x64`) that npm skips for non-matching OS/CPU; npm v11 still writes these to the lockfile with `optional: true`; no depth filter is applied since `seen` deduplicates. (b) iterates the snapshot of `results` collected so far, reads each installed package's `package.json`, collects entries in `peerDependencies` marked `optional: true` in `peerDependenciesMeta`, deduplicates by name, then resolves each version via `resolveVersionRange()` and adds if not in `seen` — catches optional peer deps like `@mui/material-pigment-css` and `esbuild` (declared by `@mui/material` and `vite` respectively) that npm v11 does **not** write to the lockfile at all. (c) **non-recursive**: iterates only packages added by pass (b), calls `npm view <name>@<version> optionalDependencies --json` for each, and adds their optional deps — catches platform packages like all 27 `@esbuild/*` variants whose parent (`esbuild`) was itself never installed by npm and therefore absent from node_modules and the lockfile; exact versions use `semver.valid()` directly, ranges fall back to `resolveVersionRange()`. Pass (c) deliberately does not feed its own outputs back in — native binary packages like `@esbuild/*` have no further `optionalDependencies`, so the chain terminates after at most two effective rounds.

**`/help` lists only user-facing commands** — admin commands (`/subscribe`, `/unsubscribe`, `/approve_client`, `/notify_client`) are intentionally omitted from the `/help` reply to keep the interface clean for regular users.

**Input validation at the upload boundary** — `POST /upload` is the trust boundary for both services. All user-controlled values are validated and rejected early rather than at job-run time. For `docker-download-service`: image names are validated against `DOCKER_IMAGE_REGEX` (≤128 chars, lowercase alphanum + `._-`, optional `org/name` prefix, optional `:tag`); platform is validated against `ALLOWED_PLATFORMS` (exported from `resolver.ts`); `images` count is capped at `MAX_IMAGES` (20). For `npm-download-service`: dep field keys (package names) are validated against `NPM_PACKAGE_NAME_REGEX`; each dep field is capped at `MAX_DEPS_PER_FIELD` (500 entries). Both services also validate the `id` parameter in `POST /jobs` against `/^\d{8}-\d{4}-\d+$/` before using it in a `path.join` — `path.join` does not block traversal sequences so format validation is the correct defence. Both `app.ts` files set an explicit `express.json({ limit: "100kb" })` body cap.

**`TRIVY_VERSION` env var** — the Trivy version used for scanning is controlled by `TRIVY_VERSION` in `docker-download-service/.env` (read at module load in `downloader.ts` as `aquasec/trivy:${TRIVY_VERSION}`). Defaults to `latest` if unset. Set it to a specific version tag (e.g. `0.62.0`) in `.env` when reproducibility or supply-chain control is required.

**`execFile` for `docker` and `trivy` in docker-download-service** — `downloader.ts` uses `execFileAsync = promisify(execFile)` for all `docker` and `trivy` invocations, for the same reason as npm: image names are user-controlled and `execFile` bypasses the shell entirely, preventing injection via metacharacters.

**Docker image tarball naming** — `latest`-tagged images get a short digest suffix so repeated pulls of `latest` produce distinct filenames: `nginx-latest-a5de3e7a.tar`. All other tags use `<name>-<tag>.tar` (e.g. `nginx-1.25.tar`), since pinned tags are stable. Slashes in namespaced image names are replaced with dashes: `bitnami/postgresql:16` → `bitnami-postgresql-16.tar`.

**Trivy for docker vulnerability scanning** — `docker-download-service` runs `trivy image --format json <image>:<tag>` after each pull, the same way npm-download-service runs `npm audit --json`. Trivy exits non-zero when vulnerabilities are found; catch the error and read `stdout` for the JSON report. Severity levels map to `{ critical, high, medium, low, unknown }` in `metadata.json`.

**Docker daemon access via host socket** — `docker-download-service` requires the Docker daemon to run `docker pull`, `docker save`, etc. When running in a container, `/var/run/docker.sock` is bind-mounted from the host. This gives the container root-equivalent access to the host Docker daemon and is acceptable for a self-hosted internal tool. Docker-in-Docker (`--privileged`) is not used.

**Copa for OS-package hardening** — `docker-download-service` runs every successfully pulled image through [Copacetic](https://github.com/project-copacetic/copacetic) (`copa`) before save. Copa is invoked as an ephemeral container (`ghcr.io/project-copacetic/copacetic:${COPA_VERSION}`, defaulting to `latest`), reads the Trivy JSON report, and patches only CVE-flagged OS packages — non-vulnerable packages are untouched. The patched image is `docker tag`'d back to the user-facing ref so `docker load` on the target machine produces the original tag (e.g. `nginx:1.27.5`). Hardening is **always-on** and **best-effort**: if Copa errors, the original unpatched image is saved instead and `hardened: false` + a short `hardenReason` are recorded in `metadata.json`. Windows images are skipped upfront (Copa is Linux-only). Copa uses BuildKit via the host Docker daemon, so the host must be Docker 23+.

**`COPA_VERSION` env var** — the Copa version is controlled by `COPA_VERSION` in `docker-download-service/.env` (read at module load in `downloader.ts` as `ghcr.io/project-copacetic/copacetic:${COPA_VERSION}`). Defaults to `latest` if unset. Pin to a specific tag (e.g. `0.9.0`) when reproducibility is required. Same pattern as `TRIVY_VERSION`.

**Two-pass Trivy with a shared named volume** — Trivy runs twice per image. The **pre-scan** is plumbing for Copa: invoked with `--output /reports/<file>.json`, it writes the JSON report into the shared `copa-reports` named docker volume (mounted at `/reports` in both the Trivy and Copa containers). The service itself never reads or writes that volume. The **post-scan** runs after Copa patches, streams JSON to stdout, and is parsed for the severity counts written to `metadata.json.audit`. The `audit` numbers users see are post-patch (the residual, not the original upstream state). The `trivy-cache` volume is shared between both invocations, so the second run is fast.

**Copa "no patchable vulnerabilities" no-op** — when the Trivy report contains no CVEs that Copa can patch, Copa exits non-zero with a stderr message containing phrases like "no patches" / "no vulnerabilities" / "no updates". `runCopaPatch` detects this with a regex (`/no.{0,30}(patches|vulnerab|updat)/i`) and treats it as a successful no-op: `hardened: true, patchedPackageCount: 0` (no `patchedTag`, so we save the original image unchanged). Any other Copa error is treated as `hardened: false` with the first non-empty stderr line as `hardenReason` (truncated to 200 chars).

**Patched-tag naming and cleanup** — Copa writes its output to a temporary tag `<image-name>:copa-<jobId>` to avoid clobbering the user-facing tag during the run. After Copa succeeds, `docker tag <copa-tag> <workingRef>` reassigns the canonical ref to point at the patched image. `docker save` then dumps the patched bytes under the user-facing tag. Cleanup `docker rmi` removes the original, the resolved-version tag (if any), AND the `copa-<jobId>` tag — all best-effort with `.catch(() => {})`.

## Known gotchas

- **`npm audit` exits with code 1** when vulnerabilities are found. `stdout` is still valid JSON. Always catch the error and read `err.stdout`; do not treat a non-zero exit as a failure.

- **Scoped packages in `node_modules`** (`@scope/pkg`) are nested one level deeper. `npm-download-service/src/resolver.ts` detects entries starting with `@` and recurses one extra level. Do not flatten this logic.

- **Tarball filename for scoped packages**: `@scope/pkg@1.0.0` → `scope-pkg-1.0.0.tgz`. Strip the leading `@`, replace the first `/` with `-`. See `tarballName()` in `npm-download-service/src/downloader.ts`.

- **`devDependencies` and `peerDependencies` are included** — `resolver.ts` merges `dependencies`, `devDependencies`, and `peerDependencies` before resolving. This is intentional; the tool targets full project snapshots. Peer deps already present in `dependencies`/`devDependencies` are not duplicated (first-writer wins). Complex peer dep version ranges containing `||` or comparison operators are resolved to the latest satisfying concrete version via `execFileAsync("npm", ["view", pkg, "versions", "--json"])` + `semver.maxSatisfying()` before the temp `package.json` is written; simple ranges (`^`, `~`, exact) are passed through as-is.

- **`/cancel` uses `delete wizardSession.__scenes.current`** — assigning `{}` to `__scenes` fails TypeScript because `WizardSessionData.cursor` is a required field. Deleting only the `current` key is the correct approach; it removes the scene marker without touching other session data.

- **`jobs.status` absent means pending** — the `status` field is optional on `Job`. Documents created by `addJob` never set it, so `{ status: { $exists: false } }` is the correct filter for pending jobs. Do not add a default `status: "pending"` string value — that would break the filter and require a migration.

- **`/notify_client` re-fetches job in step 4** — `ctx.wizard.state` stores only the `jobId` string, not the `clientId` ObjectId. ObjectIds lose their prototype through Telegraf's session serialisation and become plain objects. Re-fetching the job document by `jobId` in the final step is the correct pattern.

- **`trivy` exits with code 1** when vulnerabilities are found. `stdout` is still valid JSON. Always catch the error and read `err.stdout`; do not treat a non-zero exit as a failure. Same pattern as `npm audit`.

- **Docker socket unavailable locally** — `docker-download-service` requires a running Docker daemon. When developing locally without Docker Compose, ensure Docker Desktop or `dockerd` is running. Inside a container, the socket mount (`/var/run/docker.sock`) must be present — if it is missing, all `docker pull` calls will fail with `connect ENOENT`.

- **`docker rmi` failure is silent** — after `docker save`, `downloader.ts` calls `docker rmi` to clean up. This call is intentionally fire-and-forget (`.catch(() => {})`). If it fails (e.g. the image was tagged elsewhere), the archive is unaffected; only host storage cleanup is skipped.

- **`copa-reports` volume is auto-created and never cleaned** — the named volume `copa-reports` is implicitly created on first `docker run -v copa-reports:/reports ...`; it is not declared in `docker-compose.yml`. Trivy pre-scan reports accumulate in the volume across jobs (each file ~100 KB, named `<jobId>-<safeName>-<tag>.json`). There is no cleanup pass. To reclaim space: `docker volume rm copa-reports` while no jobs are running.

- **`digest` field reflects the SOURCE image, not the patched bytes** — when `latest` cannot be resolved via the OCI label, the `digest` in `metadata.json` is captured from the registry's RepoDigest *before* Copa patches the image. The bytes inside the tarball will differ from this digest (since Copa adds layers). The digest is kept for filename disambiguation between pulls of `latest` at different points in time; it is not a content hash of the saved tarball.

- **Copa needs Docker 23+ on the host** — Copa drives BuildKit via the Docker daemon over the mounted socket. Older Docker versions do not expose BuildKit through `docker` directly and Copa will fail with a builder-not-found error. The `hardenReason` will surface this as `"copa: ..."` but the symptom is non-obvious — verify host Docker version when Copa fails on every image in a job.

## TypeScript compilation

After any change to a `.ts` file in a package, verify the affected package compiles cleanly:

```bash
cd npm-download-service && npx tsc --noEmit
cd docker-download-service && npx tsc --noEmit
cd telegram-bot && npx tsc --noEmit
```

A clean run produces no output. Fix any errors before considering the task done.

## Output structure

### npm-download-service

Each `output/<id>.tgz` contains:

```
metadata.json
express-4.18.2.tgz
lodash-4.17.21.tgz
...
```

`metadata.json` fields: `startedAt`, `completedAt`, `summary` (total/succeeded/failed), `audit` (severity counts + `highPackages`/`criticalPackages` as `{name, version}[]`), `packages` (succeeded), `failedPackages` (with error message).

### docker-download-service

Each `output/<id>.tgz` contains:

```
metadata.json
nginx-latest-a5de3e7a.tar   ← "latest" tag + short digest
redis-7.tar                 ← pinned tag, no digest
bitnami-postgresql-16.tar
```

`metadata.json` fields: `startedAt`, `completedAt`, `summary` (total/succeeded/failed), `audit` (`{ critical, high, medium, low, unknown }` from Trivy), `packages` (succeeded, includes `digest` for `latest`-tagged images), `failedPackages` (with error message). Load images on the target machine with `docker load -i <filename>.tar`.
