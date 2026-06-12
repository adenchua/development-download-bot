# CLAUDE.md — npm-download-bot

## Repository layout

| Directory | Role |
|-----------|------|
| `npm-download-service/` | HTTP service that resolves and bundles npm dependencies as offline `.tgz` archives |
| `python-download-service/` | HTTP service that downloads Python wheels for target platforms/versions and bundles them as offline `.tgz` archives |
| `telegram-bot/` | Telegram bot for submitting download requests and managing user access |
| `database/` | MongoDB schema definitions and init scripts |

## Development commands

All three services (`npm-download-service`, `python-download-service`, `telegram-bot`) share the same scripts (run from the relevant package directory):

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
python-download-service (health: GET /health)
mongodb                 (health: mongosh ping)   ← initialised by database/init/01-init.js on first run
  └── telegram-bot      (depends on mongodb + npm-download-service + python-download-service, all healthy)
  └── mongo-express     (depends on mongodb, healthy)
```

Volume mounts:
- `npm-download-service/input/` and `output/` → `/app/input` and `/app/output`
- `python-download-service/input/` and `output/` → `/app/input` and `/app/output`
- `database/data/` → `/data/db` (MongoDB persistence)
- `database/init/` → `/docker-entrypoint-initdb.d/` (runs once on init)
- `database/schemas/` → `/schemas/` (read by init script)

`NPM_DOWNLOAD_SERVICE_URL` and `PYTHON_DOWNLOAD_SERVICE_URL` are injected directly via `environment:` in the compose file so the telegram-bot always resolves to the correct internal hostnames, regardless of what is in `telegram-bot/.env`.

## npm-download-service source map

| File | Role |
|------|------|
| `npm-download-service/src/index.ts` | HTTP server entry point; creates `input/` and `output/` dirs, starts Express on `SERVER_PORT` |
| `npm-download-service/src/app.ts` | Express app factory; mounts `filesRouter`, `resolveRouter`, and `jobsRouter`; serves Swagger UI at `GET /docs` via `swagger-ui-express`; registers global `errorHandler`; sets explicit `express.json({ limit: "100kb" })` body size cap |
| `npm-download-service/src/swagger.ts` | OpenAPI 3.1.0 document exported as `swaggerDocument`; defines all paths and reusable schemas in `components/schemas` |
| `npm-download-service/src/routes/files.ts` | `POST /upload` and `GET /files` (with `?showToday` filter); upload validates dep field keys against `NPM_PACKAGE_NAME_REGEX`, caps each field at `MAX_DEPS_PER_FIELD` (500 entries), and validates values are strings |
| `npm-download-service/src/routes/jobs.ts` | `POST /jobs` — fire-and-forget download job; validates `id` matches `/^\d{8}-\d{4}-\d+$/` before using it in a path join |
| `npm-download-service/src/middleware/errorHandler.ts` | Global Express error handler |
| `npm-download-service/src/resolver.ts` | Creates a temp dir, merges `dependencies`/`devDependencies`/`peerDependencies`, runs `npm install` to materialise the full dependency tree, walks `node_modules`, and runs the lockfile-optional scan (`collectOptionalFromLockfile()` — adds every `package-lock.json` entry with `optional: true`, catching platform-specific deps like `@esbuild/win32-x64` npm skips for non-matching OS/CPU). Runs `npm audit` on this baseline tree. Then discovers optional peer deps (scans each installed `package.json` for `peerDependencies` marked `optional: true` in `peerDependenciesMeta` — e.g. `vite` → `esbuild`, `@types/node`), and for those **not already in the merged deps** resolves each to a concrete version via `resolveVersionRange()` (`semver.maxSatisfying()`, handles `\|\|`/comparison ranges) and **reinstalls** the temp project with them added. The reinstall lets npm materialise each peer's FULL transitive closure — both regular deps (e.g. `@types/node` → `undici-types`) and platform optional deps (all `@esbuild/*`) — which a second `walkNodeModules` + `collectOptionalFromLockfile()` then collects. `addIfNew(name, version)` deduplicates across both installs; the reinstall is wrapped in try/catch (best-effort, baseline preserved on failure). |
| `npm-download-service/src/downloader.ts` | Concurrently runs `npm pack <name>@<version>` for all resolved packages via `Promise.allSettled`, collects results (succeeded/failed), bundles all tarballs + `metadata.json` into a `.tgz` via `archiver` |
| `npm-download-service/src/types.ts` | All shared TypeScript interfaces (`PackageJson`, `ResolvedPackage`, `AuditReport`, `PackageMetadata`, etc.) |

## telegram-bot source map

| File | Role |
|------|------|
| `telegram-bot/src/index.ts` | Bot entry point; registers middleware (session → cancel → stage), all command handlers, `bot.on('message')` passive handler (detects npm/python inputs silently), startup DB index creation and env var validation (`NPM_DOWNLOAD_SERVICE_URL` + `PYTHON_DOWNLOAD_SERVICE_URL` all required) |
| `telegram-bot/src/db/index.ts` | MongoDB connection management (`connectDb`, `getDb`, `closeDb`) |
| `telegram-bot/src/db/clients.ts` | `clients` collection: `registerClient`, `approveClient`, `grantAdmin`, `getClientByTelegramId`, `getClientById`, `getPendingClients`, `ensureIndexes` — `Client` interface includes optional `isAdmin` field |
| `telegram-bot/src/db/subscribers.ts` | `subscribers` collection: `addSubscriber`, `removeSubscriber`, `getAllSubscribers`, `ensureIndexes` |
| `telegram-bot/src/db/jobs.ts` | `jobs` collection: `addJob`, `getPendingJobs`, `updateJobStatus`, `getJobByJobId`, `ensureIndexes` — records each download request with `clientId`, `jobId`, `startedAt`, `serviceType` (`"npm"` \| `"python"`, optional for backwards compat with pre-existing docs); optional `status` (`"success"` \| `"failed"`), `completedAt`, and `completedBy` (Telegram ID of the admin who resolved it) set by `/notify_client`; `getPendingJobs(limit, maxAgeDays?)` accepts an optional `maxAgeDays` — when provided, adds `startedAt: { $gte: now - maxAgeDays * 24h }` to the query |
| `telegram-bot/src/commands/helpers.ts` | Shared helpers: `BotContext`, `getText`, `requireText`, `checkSecret`, `MAX_PACKAGE_JSON_BYTES`, `ALLOWED_MIME_TYPES`, `CALLBACK_PREFIXES`, `formatClientName`, `requireCallbackData`, `SECRET_PROMPT_STEP` — `SECRET_PROMPT_STEP` checks `isAdmin` in DB and bypasses the prompt for known admins; `checkSecret` persists `isAdmin` via `grantAdmin` and auto-subscribes via `addSubscriber` on first successful validation. Service-specific parsers have moved to `commands/parsers/`. |
| `telegram-bot/src/commands/parsers/npm.ts` | npm-specific parsing: `parseAndValidatePackageJson(text)` and `parseNpmUrl(text)` (moved from `helpers.ts`). `parseAndValidatePackageJson` validates a JSON string and returns a field-allowlisted object or `null`. `parseNpmUrl` matches an npmjs.com URL and returns `{ name, version }` with shell-metacharacter validation. |
| `telegram-bot/src/commands/parsers/python.ts` | Python-specific parsing: `parsePyPIUrl(text)` matches `pypi.org/project/<name>/` and `pypi.org/project/<name>/<version>/` URLs, returning `{ requirements: { [name]: versionSpec } }` or `null`. `parseRequirementsTxt(text)` validates requirements.txt content line by line (skips comments, option lines, environment markers); returns `{ requirements }` or `null` if no valid package lines found. `parsePyprojectToml(text)` parses Poetry-format `pyproject.toml` via `@iarna/toml`, extracts `[tool.poetry.dependencies]` and all `[tool.poetry.group.*.dependencies]` (skips `python` key), converts caret/tilde specs to pip-compatible ranges (`^1.2.3` → `>=1.2.3,<2.0.0`, `~1.2.0` → `>=1.2.0,<1.3.0`); returns `{ requirements, devRequirements }` or `null` if not a poetry project. |
| `telegram-bot/src/commands/approveClient.ts` | 4-step wizard: (secret prompt or admin bypass) → validate → show inline keyboard of pending clients → confirm with Yes/No buttons → approve |
| `telegram-bot/src/commands/notifyClient.ts` | 4-step wizard: (secret prompt or admin bypass) → validate → show inline keyboard of last 5 pending jobs from the past 7 days (no `status` field) → select job → Success/Failed buttons → update `status`/`completedAt`/`completedBy` in DB → send outcome message to original requestor. Job labels are prefixed with `[npm]` or `[python]`; legacy jobs without `serviceType` fall back to `[npm]`. |
| `telegram-bot/src/commands/subscribe.ts` | Two 2-step wizards: `subscribeScene` and `unsubscribeScene` — both use the same admin-bypass step 0 |
| `telegram-bot/src/commands/request.ts` | Multi-service dispatcher: 2-step wizard that auto-detects service type from input and routes to the correct service. Detection order: (1) npmjs.com URL → npm, (2) pypi.org URL → python, (3) JSON with dep fields → npm. Inner `submitJob(ctx, serviceUrl, serviceType, payload)` handles upload → job record → job start → subscriber notification for all service types. Exports `processPackageJsonRequest`, `processNpmUrlRequest`, `processPythonUrlRequest`, `processPythonPayloadRequest`, and `resolveRawText` — all shared with the passive handler in `index.ts`. |

## python-download-service source map

| File | Role |
|------|------|
| `python-download-service/src/index.ts` | HTTP server entry point; creates `input/` and `output/` dirs, starts Express on `SERVER_PORT` (default 3002) |
| `python-download-service/src/app.ts` | Express app factory; mounts `filesRouter` and `jobsRouter`; serves Swagger UI at `GET /docs`; registers global `errorHandler`; sets explicit `express.json({ limit: "100kb" })` body size cap |
| `python-download-service/src/swagger.ts` | OpenAPI 3.1.0 document exported as `swaggerDocument` |
| `python-download-service/src/routes/files.ts` | `POST /upload` — validates `PythonPayload` via `validatePayload`, generates id, saves to `input/<id>.json`; `GET /files` (with `?showToday` filter) |
| `python-download-service/src/routes/jobs.ts` | `POST /jobs` — fire-and-forget download job; validates `id` matches `/^\d{8}-\d{4}-\d+$/`; reads input JSON and calls `downloadAndBundle` |
| `python-download-service/src/middleware/errorHandler.ts` | Global Express error handler |
| `python-download-service/src/resolver.ts` | Exports `ALLOWED_PLATFORMS`, `ALLOWED_PYTHON_VERSIONS`, `DEFAULT_PLATFORMS` (`["linux_x86_64", "win_amd64"]`), `DEFAULT_PYTHON_VERSIONS` (`["3.11", "3.12"]`), `MAX_PACKAGES` (500), `PYTHON_PACKAGE_NAME_REGEX`. `validatePayload(payload)` returns an error string or null. `resolveTargets(payload)` expands platforms × pythonVersions into a `DownloadTarget[]`, filling defaults when the fields are absent. |
| `python-download-service/src/downloader.ts` | Writes a merged `requirements.txt` from `requirements` + `devRequirements`. For each `(platform, pythonVersion)` target runs `pip3 download -r requirements.txt --only-binary :all: --platform <p> --python-version <v> --implementation cp --abi cp<VV> --dest <dir>` via `execFileAsync` (not `exec`). Results are collected with `Promise.allSettled`; successes are merged into a single deduped dir (first-writer wins by filename). Failed targets are recorded in `metadata.json`. Runs `pip-audit -r requirements.txt --format json` after download, aggregates severity counts. Bundles everything into `output/<id>.tgz` via `archiver`. |
| `python-download-service/src/types.ts` | All shared TypeScript interfaces (`PythonPayload`, `DownloadTarget`, `FailedTarget`, `AuditSeverityCounts`, `PythonMetadata`) |

## database source map

| File | Role |
|------|------|
| `database/schemas/clients.json` | Collection + unique index definition for `clients` |
| `database/schemas/subscribers.json` | Collection + unique index definition for `subscribers` |
| `database/schemas/jobs.json` | Collection + unique index on `jobId` (name: `job`) + index on `clientId` (name: `jobsByClient`) + descending index on `startedAt` (name: `jobsByDate`) for `jobs` |
| `database/init/01-init.js` | mongosh init script; reads every `*.json` from `/schemas`, creates collections and indexes |

## Architectural decisions

**No single-letter variable names** — Use descriptive names throughout. Single-letter names (e.g. `m`, `p`, `k`) are banned as they are hard to read and debug. For example, use `match` for regex results, `pkg` for package objects, `key` for object keys.

**Prettier for code formatting** — all three services (`npm-download-service`, `python-download-service`, `telegram-bot`) use Prettier (exact version, pinned in `devDependencies`) with a shared config: `trailingComma: "all"`, `printWidth: 120`, `useTabs: false`, `tabWidth: 2`. Run `npm run format` in any package to reformat all `src/**/*.{ts,js}` files. Config lives in `.prettierrc` at each package root.

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

**Service-specific parsers in `commands/parsers/`** — npm and python input parsing live in separate files rather than `helpers.ts`. `parsers/npm.ts` exports `parseAndValidatePackageJson` and `parseNpmUrl`; `parsers/python.ts` exports `parsePyPIUrl`, `parseRequirementsTxt`, and `parsePyprojectToml`. `helpers.ts` retains only truly shared utilities (`BotContext`, `getText`, `requireText`, `checkSecret`, `requireCallbackData`, `formatClientName`, `CALLBACK_PREFIXES`, `SECRET_PROMPT_STEP`, `MAX_PACKAGE_JSON_BYTES`, `ALLOWED_MIME_TYPES`). When adding a new service, add `parsers/<service>.ts` following the same pattern.

**Shared wizard helpers** — `requireCallbackData(ctx, prefix, errorMsg)` validates a callback query, answers it, and returns the data string after the given prefix — or replies with `errorMsg` and returns `null`; used by all inline-keyboard steps in admin scenes. `formatClientName(client)` joins `firstName` and `lastName` filtering out blanks. `CALLBACK_PREFIXES` is a `const` object of all inline-keyboard callback data prefixes (`SELECT_CLIENT`, `CONFIRM_ACTION`, `SELECT_JOB`, `SELECT_OUTCOME`). `SECRET_PROMPT_STEP` is the shared first wizard step used by all admin-gated scenes — replies "Enter the admin secret:" and advances the wizard.

**`serviceType` field in jobs** — the `Job` interface has an optional `serviceType?: "npm" | "python"` field. It is optional (not required) so that existing DB documents without the field continue to be read correctly. New jobs always pass `serviceType`. `/notify_client` labels use a `serviceTagMap` lookup with `"npm"` as the fallback — legacy jobs without the field display as `[npm]`.

**Passive package detection** — `index.ts` registers a `bot.on('message')` handler (after all commands) that automatically processes messages as a `/request` without the user typing a command. It triggers when a registered+approved user sends any document, text starting with `{`, an npmjs.com URL, or a pypi.org URL. For Python: files named exactly `requirements.txt` are downloaded and validated via `parseRequirementsTxt` before routing; files named exactly `pyproject.toml` are validated via `parsePyprojectToml`; both route silently to the python service on success and are silently ignored on failure. Pasted requirements.txt text is NOT detected — python text input is PyPI URL only. Before downloading any document, the handler checks `file_size` (>100 KB → silent return) and `mime_type`/file extension (now also accepts `.toml`); unrecognised types are silently ignored. JSON input is routed to npm (dep fields). The upload+job+notify logic lives in `commands/request.ts` (`submitJob` helper), shared with the wizard. The wizard replies with error messages on bad input; the passive handler silently ignores it.

**Optional-peer discovery via reinstall** — packages never placed in `node_modules` by the first `npm install` yet still needed for the offline bundle come in two categories, both handled without hand-rolled `npm view` traversal:

1. **Platform-specific optional deps** (e.g. `@esbuild/win32-x64`) that npm skips for non-matching OS/CPU. npm v11 still writes these to `package-lock.json` with `optional: true`, so `collectOptionalFromLockfile()` adds every such entry. No depth filter — `seen`/`addIfNew` deduplicates.

2. **Optional peer deps** (`peerDependencies` marked `optional: true` in `peerDependenciesMeta`) that npm v11 does **not** install or write to the lockfile at all — e.g. `vite` declares `esbuild` and `@types/node` as optional peers; `@mui/material` declares `@mui/material-pigment-css`. After the baseline walk + audit, `resolver.ts` scans each installed `package.json` for these, and for any **not already in the merged root deps** resolves a concrete version via `resolveVersionRange()` and **adds them to the temp `package.json`, then runs `npm install` a second time**. The reinstall makes npm materialise each peer's complete transitive closure; a second `walkNodeModules()` + `collectOptionalFromLockfile()` collects everything new.

The reinstall is the load-bearing fix: it captures **regular `dependencies` of optional peers** — e.g. `@types/node` → `undici-types` — which the previous `npm view <peer> optionalDependencies` pass missed entirely (it read only `optionalDependencies`, never regular `dependencies`), causing `undici-types` to 404 on an offline `npm install`. Installing `esbuild` as a real dep also pulls all `@esbuild/*` into the lockfile, so the old dedicated `@esbuild/*` pass is subsumed. Peers already in the merged deps are skipped — the user's tree already resolved them, and re-adding a newer `maxSatisfying` version would pollute the bundle with a version whose own deps were never fetched (a second cause of the `undici-types` 404). The reinstall is best-effort (try/catch); on failure the baseline results are preserved. Projects with no optional peers skip the second install entirely.

**`/help` lists only user-facing commands** — admin commands (`/subscribe`, `/unsubscribe`, `/approve_client`, `/notify_client`) are intentionally omitted from the `/help` reply to keep the interface clean for regular users.

**Input validation at the upload boundary** — `POST /upload` is the trust boundary. All user-controlled values are validated and rejected early rather than at job-run time. For `npm-download-service`: dep field keys (package names) are validated against `NPM_PACKAGE_NAME_REGEX`; each dep field is capped at `MAX_DEPS_PER_FIELD` (500 entries). Both services also validate the `id` parameter in `POST /jobs` against `/^\d{8}-\d{4}-\d+$/` before using it in a `path.join` — `path.join` does not block traversal sequences so format validation is the correct defence. Both `app.ts` files set an explicit `express.json({ limit: "100kb" })` body cap.

## Known gotchas

- **`npm audit` exits with code 1** when vulnerabilities are found. `stdout` is still valid JSON. Always catch the error and read `err.stdout`; do not treat a non-zero exit as a failure.

- **Scoped packages in `node_modules`** (`@scope/pkg`) are nested one level deeper. `npm-download-service/src/resolver.ts` detects entries starting with `@` and recurses one extra level. Do not flatten this logic.

- **Tarball filename for scoped packages**: `@scope/pkg@1.0.0` → `scope-pkg-1.0.0.tgz`. Strip the leading `@`, replace the first `/` with `-`. See `tarballName()` in `npm-download-service/src/downloader.ts`.

- **`devDependencies` and `peerDependencies` are included** — `resolver.ts` merges `dependencies`, `devDependencies`, and `peerDependencies` before resolving. This is intentional; the tool targets full project snapshots. Peer deps already present in `dependencies`/`devDependencies` are not duplicated (first-writer wins). Complex peer dep version ranges containing `||` or comparison operators are resolved to the latest satisfying concrete version via `execFileAsync("npm", ["view", pkg, "versions", "--json"])` + `semver.maxSatisfying()` before the temp `package.json` is written; simple ranges (`^`, `~`, exact) are passed through as-is.

- **`/cancel` uses `delete wizardSession.__scenes.current`** — assigning `{}` to `__scenes` fails TypeScript because `WizardSessionData.cursor` is a required field. Deleting only the `current` key is the correct approach; it removes the scene marker without touching other session data.

- **`jobs.status` absent means pending** — the `status` field is optional on `Job`. Documents created by `addJob` never set it, so `{ status: { $exists: false } }` is the correct filter for pending jobs. Do not add a default `status: "pending"` string value — that would break the filter and require a migration.

- **`/notify_client` re-fetches job in step 4** — `ctx.wizard.state` stores only the `jobId` string, not the `clientId` ObjectId. ObjectIds lose their prototype through Telegraf's session serialisation and become plain objects. Re-fetching the job document by `jobId` in the final step is the correct pattern.

**`pip download` for cross-platform wheel fetching** — `python-download-service` uses `pip3 download --only-binary :all: --platform <p> --python-version <v> --implementation cp --abi cp<VV>` via `execFileAsync` (not `exec`) for each `(platform, pythonVersion)` target. `execFile` bypasses the shell entirely; platform/version values are user-controlled after whitelist validation, so this is the correct pattern. `--only-binary :all:` is required for pip to respect the `--platform` flag when downloading for a different OS than the service host. Targets run concurrently with `Promise.allSettled`; failures are per-target (the overall job continues).

**Default platform and Python version targets** — when `platforms` and `pythonVersions` are absent from the upload payload, `python-download-service` defaults to `["linux_x86_64", "win_amd64"]` × `["3.11", "3.12"]` (4 pip runs). The full allowed sets are `ALLOWED_PLATFORMS` and `ALLOWED_PYTHON_VERSIONS` in `resolver.ts`. Both fields can be set explicitly in the payload to override.

**Wheel deduplication across targets** — pure-Python wheels (e.g. `requests-2.31.0-py3-none-any.whl`) are identical across all targets. After each successful pip run the downloader merges files into a shared dir, skipping any filename that already exists (first-writer wins). Binary wheels have unique filenames encoding platform and ABI, so they never collide.

**pip-audit for Python vulnerability scanning** — `python-download-service` runs `pip-audit -r requirements.txt --format json` after all downloads complete, the same way `npm-download-service` runs `npm audit --json`. pip-audit exits non-zero when vulnerabilities are found; catch the error and read `stdout`. Severity counts are aggregated into `{ critical, high, medium, low, unknown }` and written to `metadata.json.audit`. pip-audit failures are best-effort — if it errors the audit field is zeroed and the job completes normally.

**Poetry version spec conversion in the bot parser** — `parsers/python.ts` converts poetry-style version specs to pip-compatible syntax before building the JSON payload. `^X.Y.Z` → `>=X.Y.Z,<(X+1).0.0`, `~X.Y.Z` → `>=X.Y.Z,<X.(Y+1).0`, `*` → `*`. The `python-download-service` API only ever receives pip-compatible specifiers; it never sees poetry syntax. The `python` key in `[tool.poetry.dependencies]` is skipped (it is a Python version constraint, not a package).

**`@iarna/toml` for pyproject.toml parsing** — `parsers/python.ts` uses `@iarna/toml` (a pure-JS TOML parser) to read pyproject.toml. Regex-based TOML parsing is fragile for nested tables and inline tables, so a proper parser is used. Only `tool.poetry.*` keys are examined; non-poetry pyproject.toml files return null.

## TypeScript compilation

After any change to a `.ts` file in a package, verify the affected package compiles cleanly:

```bash
cd npm-download-service && npx tsc --noEmit
cd python-download-service && npx tsc --noEmit
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

### python-download-service

Each `output/<id>.tgz` contains:

```
metadata.json
numpy-2.2.0-cp311-cp311-linux_x86_64.whl
numpy-2.2.0-cp311-cp311-win_amd64.whl
numpy-2.2.0-cp312-cp312-linux_x86_64.whl
numpy-2.2.0-cp312-cp312-win_amd64.whl
requests-2.31.0-py3-none-any.whl   ← pure-Python wheel, one copy for all targets
...
```

`metadata.json` fields: `startedAt`, `completedAt`, `summary` (`totalTargets`/`succeededTargets`/`failedTargets`), `files` (list of all wheel filenames in the archive), `failedTargets` (array of `{ platform, pythonVersion, error }` for targets that failed), `audit` (`{ critical, high, medium, low, unknown }` from pip-audit). Install on the target machine with `pip install --no-index --find-links . <package-name>`.
