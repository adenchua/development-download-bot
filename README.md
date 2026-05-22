# npm-download-bot

A system for downloading npm packages offline and managing user access via Telegram.

## Architecture

| Service | Port | Purpose |
|---------|------|---------|
| `npm-download-service` | 3000 | HTTP API — resolves transitive npm dependencies and packages them as `.tgz` archives |
| `docker-download-service` | 3000 (internal) | HTTP API — pulls Docker images and packages them as `.tgz` archives |
| `telegram-bot` | — | Telegram bot — submit download requests and manage user access |
| `mongodb` | 27017 (internal) | Persistent storage for registered users, subscribers, and job history |
| `mongo-express` | 8081 | Web UI for inspecting the database |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

## Setup

**1. Copy all environment templates and fill in the required values:**

```bash
cp database/.env.template database/.env
cp telegram-bot/.env.template telegram-bot/.env
cp npm-download-service/.env.template npm-download-service/.env
cp docker-download-service/.env.example docker-download-service/.env
```

| File | Variables to fill in |
|------|----------------------|
| `database/.env` | `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, `ME_CONFIG_MONGODB_ADMINUSERNAME`, `ME_CONFIG_MONGODB_ADMINPASSWORD`, `ME_CONFIG_BASICAUTH_USERNAME`, `ME_CONFIG_BASICAUTH_PASSWORD` |
| `telegram-bot/.env` | `TELEGRAM_BOT_TOKEN` (from [@BotFather](https://t.me/BotFather)), `MONGODB_URI` (use `mongodb://<user>:<pass>@mongodb:27017`), `APPROVE_SECRET` (strong random value) |
| `npm-download-service/.env` | `SERVER_PORT` (default: `3000`) |
| `docker-download-service/.env` | `SERVER_PORT` (default: `3000`) |

> `NPM_DOWNLOAD_SERVICE_URL` and `DOCKER_DOWNLOAD_SERVICE_URL` are set automatically by Docker Compose for the telegram-bot. No manual configuration needed.

**2. Start all services:**

```bash
docker compose up
```

On the **first run**, MongoDB initialises automatically: collections and indexes are created from `database/schemas/*.json`. This only runs once while the data volume is empty.

## Starting and stopping

```bash
docker compose up              # start all services
docker compose up --build      # rebuild images after code changes
docker compose down            # stop all services (data is preserved)
docker compose down -v         # stop and delete all data volumes (DB init runs again on next start)
```

> **Note:** `database/data/` is a bind-mounted host directory, not a Docker named volume. `docker compose down -v` does **not** clear it. To fully reset the database (e.g. after changing credentials), delete it manually: `rm -rf database/data/`.

## Viewing logs

```bash
docker compose logs -f telegram-bot
docker compose logs -f npm-download-service
docker compose logs -f docker-download-service
docker compose logs -f mongodb
```

## Services

- **npm-download-service** — REST API at `http://localhost:3000`. Interactive API docs at `http://localhost:3000/docs`. See [npm-download-service/README.md](npm-download-service/README.md).
- **docker-download-service** — REST API (internal only, not exposed on host). Interactive API docs at `http://localhost:3000/docs` inside the container. See [docker-download-service/README.md](docker-download-service/README.md).
- **telegram-bot** — Telegram bot. See [telegram-bot/README.md](telegram-bot/README.md).
- **database** — MongoDB configuration and schema definitions. See [database/README.md](database/README.md).
- **mongo-express** — Database UI at `http://localhost:8081`.
