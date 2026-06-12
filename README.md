# development-download-bot

A self-hosted system for downloading packages offline and managing user access via Telegram. Users submit package requests through the bot; the download services resolve and bundle everything into a single `.tgz` archive ready for transfer to an air-gapped environment.

## Architecture

<!-- prettier-ignore -->
| Service | Host port | Purpose |
|---------|-----------|---------|
| `npm-download-service` | 3000 | REST API — resolves transitive npm dependencies and packages them as `.tgz` archives |
| `python-download-service` | 3002 | REST API — downloads Python wheels for specified platforms and Python versions, packages them as `.tgz` archives |
| `telegram-bot` | — | Telegram bot — submit download requests and manage user access |
| `mongodb` | 27017 (internal) | Persistent storage for registered users, subscribers, and job history |
| `mongo-express` | 8081 | Web UI for inspecting the database |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

**1. Copy all environment templates and fill in the required values:**

```bash
cp database/.env.template database/.env
cp telegram-bot/.env.template telegram-bot/.env
cp npm-download-service/.env.template npm-download-service/.env
cp python-download-service/.env.template python-download-service/.env
```

<!-- prettier-ignore -->
| File | Variables to fill in |
|------|----------------------|
| `database/.env` | `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, `ME_CONFIG_MONGODB_ADMINUSERNAME`, `ME_CONFIG_MONGODB_ADMINPASSWORD`, `ME_CONFIG_BASICAUTH_USERNAME`, `ME_CONFIG_BASICAUTH_PASSWORD` |
| `telegram-bot/.env` | `TELEGRAM_BOT_TOKEN`, `MONGODB_URI` (e.g. `mongodb://<user>:<pass>@mongodb:27017`), `APPROVE_SECRET` (strong random value) |
| `npm-download-service/.env` | `SERVER_PORT` (default: `3000`) |
| `python-download-service/.env` | `SERVER_PORT` (default: `3002`) |

> `NPM_DOWNLOAD_SERVICE_URL` and `PYTHON_DOWNLOAD_SERVICE_URL` are injected automatically by Docker Compose into the telegram-bot. No manual configuration needed.

**2. Uncomment the `telegram-bot` service in `docker-compose.yml`** (it is commented out by default).

**3. Start all services:**

```bash
docker compose up --build
```

On the **first run**, MongoDB initialises automatically: collections and indexes are created from `database/schemas/*.json`. This only runs once while the data volume is empty.

## Starting and stopping

```bash
docker compose up              # start all services
docker compose up --build      # rebuild images after code changes
docker compose down            # stop all services (data is preserved)
docker compose down -v         # stop and delete named volumes
```

> **Note:** `database/data/` is a bind-mounted host directory, not a Docker named volume. `docker compose down -v` does **not** clear it. To fully reset the database, delete it manually: `rm -rf database/data/`.

## Viewing logs

```bash
docker compose logs -f telegram-bot
docker compose logs -f npm-download-service
docker compose logs -f python-download-service
docker compose logs -f mongodb
```

## Bot usage

Users interact entirely through Telegram. The bot auto-detects input type — no command needed for most workflows.

**Supported inputs:**

<!-- prettier-ignore -->
| Input | Service |
|-------|---------|
| `package.json` file or pasted JSON with `dependencies` / `devDependencies` / `peerDependencies` | npm |
| `npmjs.com/package/<name>` URL | npm |
| `requirements.txt` file | Python |
| `pyproject.toml` file (Poetry format) | Python |
| `pypi.org/project/<name>/` or `pypi.org/project/<name>/<version>/` URL | Python |

**Commands:**

<!-- prettier-ignore -->
| Command | Description |
|---------|-------------|
| `/register` | Register your account |
| `/request` | Start an interactive download request wizard |
| `/cancel` | Cancel the current conversation |
| `/help` | Show available commands |

Admin-only commands (require `APPROVE_SECRET`): `/approve_client`, `/notify_client`, `/subscribe`, `/unsubscribe`.

## Output archives

All services produce a `.tgz` archive in their `output/` directory, identified by the job ID (`yyyyMMdd-HHmm-N`).

**npm** — `output/<id>.tgz` contains individual `.tgz` npm tarballs and `metadata.json`. Install offline with:

```bash
npm install --prefer-offline --cache ./cache <package-name>
# or unpack tarballs into a local registry
```

**Python** — `output/<id>.tgz` contains `.whl` wheel files for all requested platforms and Python versions, plus `metadata.json`. Install offline with:

```bash
pip install --no-index --find-links . <package-name>
```

## API docs

Each download service exposes a Swagger UI:

- npm: `http://localhost:3000/docs`
- python: `http://localhost:3002/docs`
