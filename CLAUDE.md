# CLAUDE.md — npm-download-bot

## Repository layout

| Directory | Role |
|-----------|------|
| `npm-download-service/` | HTTP service that resolves and bundles npm dependencies as offline `.tgz` archives |
| `telegram-bot/` | Telegram bot for submitting download requests and managing user access |
| `database/` | MongoDB schema definitions and init scripts |

## Development commands

Both `npm-download-service` and `telegram-bot` share the same scripts (run from the relevant package directory):

| Command | Description |
|---------|-------------|
| `npm start` | Run with `tsx` — no build step; requires a populated `.env` |
| `npm run dev` | Same as `start` but restarts on file changes |
| `npm run build` | Compile TypeScript to `dist/` via `tsc` |
| `npm run format` | Reformat all `src/**/*.{ts,js}` with Prettier |

## Docker Compose

Four services with explicit health-check dependencies:

```
npm-download-service  (health: GET /health)
mongodb               (health: mongosh ping)   ← initialised by database/init/01-init.js on first run
  └── telegram-bot    (depends on mongodb + npm-download-service, both healthy)
  └── mongo-express   (depends on mongodb, healthy)
```

Volume mounts:
- `npm-download-service/input/` and `output/` → `/app/input` and `/app/output`
- `database/data/` → `/data/db` (MongoDB persistence)
- `database/init/` → `/docker-entrypoint-initdb.d/` (runs once on init)
- `database/schemas/` → `/schemas/` (read by init script)

`NPM_DOWNLOAD_SERVICE_URL` is injected directly via `environment:` in the compose file so the telegram-bot always resolves to `http://npm-download-service:3000` inside Docker, regardless of what is in `telegram-bot/.env`.

## npm-download-service source map

| File | Role |
|------|------|
| `npm-download-service/src/index.ts` | HTTP server entry point; creates `input/` and `output/` dirs, starts Express on `SERVER_PORT` |
| `npm-download-service/src/app.ts` | Express app factory; mounts `filesRouter`, `resolveRouter`, and `jobsRouter`; serves Swagger UI at `GET /docs` via `swagger-ui-express`; registers global `errorHandler` |
| `npm-download-service/src/swagger.ts` | OpenAPI 3.1.0 document exported as `swaggerDocument`; defines all paths and reusable schemas in `components/schemas` |
| `npm-download-service/src/routes/files.ts` | `POST /upload` and `GET /files` (with `?showToday` filter) |
| `npm-download-service/src/routes/jobs.ts` | `POST /jobs` — fire-and-forget download job |
| `npm-download-service/src/middleware/errorHandler.ts` | Global Express error handler |
| `npm-download-service/src/resolver.ts` | Creates a temp dir, merges `dependencies`/`devDependencies`/`peerDependencies`, runs `npm install` to materialise the full dependency tree, walks `node_modules`, reads `package-lock.json` to collect optional packages skipped by npm due to host OS/CPU mismatch (e.g. all `@esbuild/*` platform variants), then runs `npm audit`. Complex peer dep version ranges (`\|\|`, comparisons) are resolved to a concrete latest version via `semver.maxSatisfying()` before install. |
| `npm-download-service/src/downloader.ts` | Iterates resolved packages, runs `npm pack <name>@<version>` for each, bundles all tarballs + `metadata.json` into a `.tgz` via `archiver` |
| `npm-download-service/src/types.ts` | All shared TypeScript interfaces (`PackageJson`, `ResolvedPackage`, `AuditReport`, `PackageMetadata`, etc.) |

## telegram-bot source map

| File | Role |
|------|------|
| `telegram-bot/src/index.ts` | Bot entry point; registers middleware (session → cancel → stage), all command handlers, `bot.on('message')` passive package.json handler, startup DB index creation and env var validation |
| `telegram-bot/src/db/index.ts` | MongoDB connection management (`connectDb`, `getDb`, `closeDb`) |
| `telegram-bot/src/db/clients.ts` | `clients` collection: `registerClient`, `approveClient`, `grantAdmin`, `getClientByTelegramId`, `getClientById`, `getPendingClients`, `ensureIndexes` — `Client` interface includes optional `isAdmin` field |
| `telegram-bot/src/db/subscribers.ts` | `subscribers` collection: `addSubscriber`, `removeSubscriber`, `getAllSubscribers`, `ensureIndexes` |
| `telegram-bot/src/db/jobs.ts` | `jobs` collection: `addJob`, `getPendingJobs`, `updateJobStatus`, `getJobByJobId`, `ensureIndexes` — records each download request with `clientId`, `jobId`, `startedAt`; optional `status` (`"success"` \| `"failed"`), `completedAt`, and `completedBy` (Telegram ID of the admin who resolved it) set by `/notify_client`; `getPendingJobs(limit, maxAgeDays?)` accepts an optional `maxAgeDays` — when provided, adds `startedAt: { $gte: now - maxAgeDays * 24h }` to the query |
| `telegram-bot/src/commands/helpers.ts` | Shared helpers: `BotContext`, `getText`, `requireText`, `checkSecret`, `parseAndValidatePackageJson`, `parseNpmUrl`, `MAX_PACKAGE_JSON_BYTES`, `ALLOWED_MIME_TYPES`, `CALLBACK_PREFIXES`, `formatClientName`, `requireCallbackData`, `SECRET_PROMPT_STEP` — `SECRET_PROMPT_STEP` checks `isAdmin` in DB and bypasses the prompt for known admins; `checkSecret` persists `isAdmin` via `grantAdmin` and auto-subscribes via `addSubscriber` on first successful validation |
| `telegram-bot/src/commands/approveClient.ts` | 4-step wizard: (secret prompt or admin bypass) → validate → show inline keyboard of pending clients → confirm with Yes/No buttons → approve |
| `telegram-bot/src/commands/notifyClient.ts` | 4-step wizard: (secret prompt or admin bypass) → validate → show inline keyboard of last 5 pending jobs from the past 7 days (no `status` field) → select job → Success/Failed buttons → update `status`/`completedAt`/`completedBy` in DB → send outcome message to original requestor |
| `telegram-bot/src/commands/subscribe.ts` | Two 2-step wizards: `subscribeScene` and `unsubscribeScene` — both use the same admin-bypass step 0 |
| `telegram-bot/src/commands/request.ts` | 2-step wizard: prompt for `package.json` or npmjs.com URL → validate → `POST /upload` → record job in `jobs` collection → `POST /jobs` → reply job ID → notify all subscribers. Exports `processPackageJsonRequest(ctx, pkg)` and `processNpmUrlRequest(ctx, name, version)` — both shared by the wizard and the passive message handler in `index.ts` |

## database source map

| File | Role |
|------|------|
| `database/schemas/clients.json` | Collection + unique index definition for `clients` |
| `database/schemas/subscribers.json` | Collection + unique index definition for `subscribers` |
| `database/schemas/jobs.json` | Collection + unique index on `jobId` (name: `job`) + index on `clientId` (name: `jobsByClient`) + descending index on `startedAt` (name: `jobsByDate`) for `jobs` |
| `database/init/01-init.js` | mongosh init script; reads every `*.json` from `/schemas`, creates collections and indexes |

## Architectural decisions

**No single-letter variable names** — Use descriptive names throughout. Single-letter names (e.g. `m`, `p`, `k`) are banned as they are hard to read and debug. For example, use `match` for regex results, `pkg` for package objects, `key` for object keys.

**Prettier for code formatting** — both `npm-download-service` and `telegram-bot` use Prettier (exact version, pinned in `devDependencies`) with a shared config: `trailingComma: "all"`, `printWidth: 120`, `useTabs: false`, `tabWidth: 2`. Run `npm run format` in either package to reformat all `src/**/*.{ts,js}` files. Config lives in `.prettierrc` at each package root.

**Import ordering** — imports are grouped in three sections, each separated by a blank line: (1) internet/npm packages (e.g. `express`, `telegraf`, `date-fns`), (2) Node.js built-in/library packages (e.g. `fs`, `path`, `os`, `child_process`), (3) project-local imports (e.g. `./app`, `../types`). No `import * as X` wildcard imports for internet or library packages — always use named imports (e.g. `import { readFileSync, writeFileSync } from "fs"`). In `downloader.ts` the Promise executor uses `(resolveZip, rejectZip)` to avoid shadowing the `resolve` named import from `path`.

**tsx instead of ts-node** — no build step needed; `npm start` executes TypeScript directly via esbuild. `npm run build` (tsc → `dist/`) exists for producing a compiled binary but is not required for development.

**HTTP API instead of interactive CLI** — the service exposes a REST API. Upload a `package.json` via `POST /upload`, then trigger a job via `POST /jobs`. The old interactive prompt (`@inquirer/prompts`) has been replaced.

**File stem as archive ID** — uploaded files are saved as `input/<id>.json` where the ID is `yyyyMMdd-HHmm-X` (X = 1-indexed count of `.json` files in `input/` at upload time). This produces `output/<id>.tgz`. No separate manifest file.

**`execFile` (not `exec`) for `npm pack` and `npm view`** — both `downloader.ts` and `resolver.ts` use `execFileAsync = promisify(execFile)` rather than `execAsync = promisify(exec)` for calls that include user-controlled arguments (`npm pack <name>@<version>` and `npm view <packageName> versions --json`). `execFile` bypasses the shell entirely, so package names containing shell metacharacters are passed as literal strings to the npm binary. `npm install` and `npm audit` remain on `execAsync` since their arguments are hardcoded.

**`maxBuffer: 1024 * 1024 * 1024` on `npm pack`** — large packages (e.g. `@mui/icons-material`) emit multi-megabyte stderr (peer dependency warnings). The default 1 MB buffer causes silent failures. Set to 1 GB; only text is buffered, not binary tarballs.

**`--no-audit` on `npm install`, explicit `npm audit --json` after** — `--no-audit` only suppresses the inline install-time report; it does not affect `package-lock.json`. Running `npm audit --json` separately after install reads the lock file and always produces accurate results.

**`date-fns` for local-time timestamps** — all timestamps (`startedAt`, `completedAt`, `uploadedAt`, health check) use `formatISO()` from `date-fns`, which produces local time with UTC offset (e.g. `2026-03-21T10:00:00+08:00`) instead of UTC `Z` strings. The ID prefix uses `format(new Date(), 'yyyyMMdd-HHmm')` for a compact local-time stamp. `telegram-bot` also uses `date-fns` (`format()`) when displaying `registeredAt` timestamps to the admin in the approve-client flow.

**`TZ=Asia/Singapore` in containers** — `npm-download-service` and `telegram-bot` both set `TZ: Asia/Singapore` via `environment:` in `docker-compose.yml`. Without this, Node.js inside the container uses UTC, making all `date-fns` local-time calls produce UTC timestamps and UTC-offset IDs (`+00:00`).

**Schema-driven DB initialisation** — `database/schemas/*.json` are the single source of truth for collection structure. `database/init/01-init.js` reads all JSON files generically on first MongoDB startup; adding a new collection means adding one JSON file with no changes to the init script.

**`$setOnInsert` upsert for idempotent registration** — `registerClient` and `addSubscriber` use `updateOne({ telegramId }, { $setOnInsert: data }, { upsert: true })`. Re-registering returns `upsertedCount === 0` and is a complete no-op in the database; the original document is never overwritten.

**`ensureIndexes()` at startup** — `clients.ts`, `subscribers.ts`, and `jobs.ts` each expose an `ensureIndexes()` function that calls `createIndex` for each required named index. All three are called in `main()` before `bot.launch()`. MongoDB's `createIndex` is idempotent — it is a no-op if the index already exists — so this works correctly whether the DB is fresh or pre-existing. This replaces the old `verifyIndexes` pattern that would refuse to start if indexes were absent.

**`APPROVE_SECRET` as a one-time admin gate** — the secret is read from `process.env.APPROVE_SECRET` once at module load in `commands/helpers.ts`. On first use, admin commands prompt for the secret; on a match, `checkSecret()` calls `grantAdmin()` (upserts `isAdmin: true` and `isApproved: true`, auto-registering the user if needed) and `addSubscriber()` (idempotent — no-op if already subscribed). `SECRET_PROMPT_STEP` checks the DB before every admin command: if `isAdmin` is already set it skips the prompt, sets `ctx.wizard.state.isAdmin = true`, and invokes step 1 directly via `ctx.wizard.selectStep(1)` + `ctx.wizard.step(ctx, next)`. `checkSecret()` short-circuits to `true` when `ctx.wizard.state.isAdmin` is set, so the secret text passed from the command message is never compared.

**`/cancel` middleware ordering** — the cancel command is registered on the bot after `session()` but before `stage.middleware()`. This ensures it intercepts `/cancel` before any active scene's step handlers can consume the message. It reads `ctx.session.__scenes.current` (via the typed `Scenes.WizardSession` cast) to detect whether a scene is active.

**Shared wizard helpers** — all shared helpers live in `commands/helpers.ts`. `parseAndValidatePackageJson(text)` parses a JSON string, asserts the result is a non-array object with at least one dep field, validates that all dep values are strings (prevents resolver crashes), and returns only the allowlisted fields (`name`, `version`, `dependencies`, `devDependencies`, `peerDependencies`) — stripping everything else before it reaches `/upload`. Returns `null` on any failure. `parseNpmUrl(text)` matches an npmjs.com package URL and returns `{ name, version }` — defaulting to `"latest"` when no `/v/<version>` segment is present. Query strings and fragments (e.g. `?activeTab=dependencies`) are stripped before matching so tab URLs copied directly from npmjs.com work. After matching, `name` is validated against npm naming rules (`^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$`, ≤214 chars) and `version` against a safe character set (`^[a-zA-Z0-9][a-zA-Z0-9._+\-]*$`, ≤64 chars) — this rejects shell metacharacters at the earliest entry point. Returns `null` for non-matching or invalid input. `requireCallbackData(ctx, prefix, errorMsg)` validates a callback query, answers it, and returns the data string after the given prefix — or replies with `errorMsg` and returns `null`; used by all inline-keyboard steps in admin scenes. `formatClientName(client)` joins `firstName` and `lastName` filtering out blanks. `CALLBACK_PREFIXES` is a `const` object of all inline-keyboard callback data prefixes (`SELECT_CLIENT`, `CONFIRM_ACTION`, `SELECT_JOB`, `SELECT_OUTCOME`). `SECRET_PROMPT_STEP` is the shared first wizard step used by all admin-gated scenes — replies "Enter the admin secret:" and advances the wizard.

**Passive package detection** — `index.ts` registers a `bot.on('message')` handler (after all commands) that automatically processes messages as a `/request` without the user typing a command. It triggers when a registered+approved user sends any document, text starting with `{`, or an npmjs.com package URL. Before downloading a document, the handler checks `file_size` (>100 KB → silent return) and `mime_type`/file extension against `ALLOWED_MIME_TYPES` (`application/json`, `text/plain`, `text/json`, `application/octet-stream`, `.json`, `.txt`); unrecognised types are silently ignored. After downloading, body length is rechecked as defence-in-depth. Both document and text paths use `parseAndValidatePackageJson` and silently ignore invalid input. npm URL inputs are handled by `parseNpmUrl` and routed to `processNpmUrlRequest`. The upload+job+notify logic lives in `commands/request.ts`, shared with the wizard. The wizard applies the same size and MIME checks but replies with error messages instead of silently ignoring.

**`package-lock.json` scan for platform-specific optional deps** — `npm install` only installs `optionalDependencies` that match the current host `os`/`cpu`. Packages like `@esbuild/win32-x64` or `@esbuild/darwin-arm64` are silently skipped on Linux and never appear in `node_modules`. npm v7+ (lockfileVersion 2/3) always writes every optional dep into `package-lock.json` regardless of platform. After `walkNodeModules`, `resolver.ts` reads `package-lock.json` and adds every `optional: true` entry not already in `seen`. Entries with more than one `node_modules/` path segment are skipped (those are nested optional deps of transitive packages, which the walk already handles).

**`/help` lists only user-facing commands** — admin commands (`/subscribe`, `/unsubscribe`, `/approve_client`, `/notify_client`) are intentionally omitted from the `/help` reply to keep the interface clean for regular users.

## Known gotchas

- **`npm audit` exits with code 1** when vulnerabilities are found. `stdout` is still valid JSON. Always catch the error and read `err.stdout`; do not treat a non-zero exit as a failure.

- **Scoped packages in `node_modules`** (`@scope/pkg`) are nested one level deeper. `npm-download-service/src/resolver.ts` detects entries starting with `@` and recurses one extra level. Do not flatten this logic.

- **Tarball filename for scoped packages**: `@scope/pkg@1.0.0` → `scope-pkg-1.0.0.tgz`. Strip the leading `@`, replace the first `/` with `-`. See `tarballName()` in `npm-download-service/src/downloader.ts`.

- **`devDependencies` and `peerDependencies` are included** — `resolver.ts` merges `dependencies`, `devDependencies`, and `peerDependencies` before resolving. This is intentional; the tool targets full project snapshots. Peer deps already present in `dependencies`/`devDependencies` are not duplicated (first-writer wins). Complex peer dep version ranges containing `||` or comparison operators are resolved to the latest satisfying concrete version via `execFileAsync("npm", ["view", pkg, "versions", "--json"])` + `semver.maxSatisfying()` before the temp `package.json` is written; simple ranges (`^`, `~`, exact) are passed through as-is.

- **`/cancel` uses `delete wizardSession.__scenes.current`** — assigning `{}` to `__scenes` fails TypeScript because `WizardSessionData.cursor` is a required field. Deleting only the `current` key is the correct approach; it removes the scene marker without touching other session data.

- **`jobs.status` absent means pending** — the `status` field is optional on `Job`. Documents created by `addJob` never set it, so `{ status: { $exists: false } }` is the correct filter for pending jobs. Do not add a default `status: "pending"` string value — that would break the filter and require a migration.

- **`/notify_client` re-fetches job in step 4** — `ctx.wizard.state` stores only the `jobId` string, not the `clientId` ObjectId. ObjectIds lose their prototype through Telegraf's session serialisation and become plain objects. Re-fetching the job document by `jobId` in the final step is the correct pattern.

## TypeScript compilation

After any change to a `.ts` file in either package, verify the affected package compiles cleanly:

```bash
cd npm-download-service && npx tsc --noEmit
cd telegram-bot && npx tsc --noEmit
```

A clean run produces no output. Fix any errors before considering the task done.

## Output structure (npm-download-service)

Each `output/<id>.tgz` contains:

```
metadata.json
express-4.18.2.tgz
lodash-4.17.21.tgz
...
```

`metadata.json` fields: `startedAt`, `completedAt`, `summary` (total/succeeded/failed), `audit` (severity counts + `highPackages`/`criticalPackages` as `{name, version}[]`), `packages` (succeeded), `failedPackages` (with error message).
