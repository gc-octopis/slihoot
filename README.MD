# Slihoot

The combination of Slido, Kahoot, and more.

Slihoot is a self-hosted live interaction web app: an admin builds events with
questions, opens a live session with a join code, and participants answer in
real time over WebSocket while results, a word cloud, and a Q&A wall update live.

## Features

- Single admin login with `ADMIN_PASSWORD` (JWT-based).
- Event CRUD and activity editing.
- Activity types: multiple choice, true/false, short answer, word cloud.
- Live session start/end with join code; per-question timer and answer reveal.
- Participant join with nickname and local token recovery.
- WebSocket state sync for current activity, answer counts, and results.
- Q&A messages with admin hide/show/delete/pin moderation.
- **MySQL** persistence with a versioned, file-based migration runner.
- **Redis** (single instance) used as an optimisation layer — live-state cache,
  per-participant rate limiting, and online-presence counts. The app degrades
  gracefully to MySQL-only if Redis is absent.
- `/healthz` health check, request logging, graceful shutdown.
- Docker Compose stack with **Caddy** reverse proxy + automatic HTTPS.
- GitHub Actions CI (typecheck + build + image build) and optional CD.

## Architecture

```
                        :80 / :443 (HTTPS, auto-cert)
  Browser  ───────────────►  Caddy  ──────►  app (Bun + Hono, WebSocket)
  (wss://)                  reverse                 │
                            proxy                   ├──►  MySQL 8.4   (source of truth)
                                                    └──►  Redis 7     (cache / rate-limit / presence)
```

Single-instance by design: live-session room state lives in process memory, so
the app must run as one instance (no horizontal scaling without adding pub/sub).
This is plenty for the target scale (~80–150 concurrent participants).

## Tech stack

Bun · Hono · React 19 + Vite · MySQL 8.4 · Redis 7 · Caddy 2 · Docker Compose.

## Environment variables

Copy `.env.example` to `.env` and adjust. Defaults are dev-only — **override the
secrets before going live.**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | App listen port |
| `ADMIN_PASSWORD` | `change-me` | Admin login password |
| `JWT_SECRET` | dev placeholder | Admin token signing secret |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MySQL host/port |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `slihoot` | MySQL credentials/db |
| `DB_AUTO_MIGRATE` | `true` | Run migrations on boot |
| `MYSQL_ROOT_PASSWORD` | `root` | MySQL root pw (compose only) |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection; empty = disable Redis |
| `RATE_LIMIT_JOIN_PER_MIN` | `300` | Per-IP join cap (kept high for NAT'd rooms) |
| `DOMAIN` | empty (`:80`) | Hostname for Caddy auto-HTTPS; empty = plain HTTP |
| `CLOUDFLARED_PATH` | empty | Optional cloudflared binary for quick tunnels |

## Local development

```bash
bun install
cp .env.example .env

# Start only the datastores via Docker, run the app from source:
docker compose up -d mysql redis
bun run dev          # backend (watch)
bun run dev:web      # Vite frontend (another terminal)
```

- Participant entry: `http://localhost:5173/`
- Admin login: `http://localhost:5173/admin`

### Join from a phone

The local QR/share dialog intentionally stays on the current origin and does not auto-start
an external tunnel. Sharing a `localhost` link won't work on phones. Either:

1. **Same Wi-Fi / LAN:** `bun run dev:web` serves on `0.0.0.0`; share `http://<your-lan-ip>:5173/`.
2. **Different networks:** use the deployed remote site, or explicitly run your own tunnel when you need external access to the local dev server.

## Run the full stack with Docker

```bash
docker compose up -d --build
```

Services: `app` (bound to `127.0.0.1:3000`), `caddy` (`:80`/`:443`), `mysql`,
`redis`. With `DOMAIN` unset, browse `http://localhost`.

## Operations

```bash
curl -s localhost:3000/healthz        # {"status":"ok","checks":{"mysql":true,"redis":true}}
docker compose logs -f app            # request + lifecycle logs (rotated, 10m x3)
docker compose ps                     # container/health status
```

- **Migrations:** add `migrations/NNNN_name.sql`; applied automatically on boot
  (tracked in the `schema_migrations` table). Run at most once each.
- **Load test:** with a live session running and its question started:

  ```bash
  BASE_URL=http://127.0.0.1:3000 JOIN_CODE=ABC123 COUNT=80 bun run loadtest
  ```

## Deploy to GCP (Compute Engine VM, self-hosted Docker stack)

This runs everything (app + MySQL + Redis + Caddy) on a single VM via Docker
Compose. No Cloud SQL / Memorystore required.

### 1. Create the VM

- **Machine type:** `n4-standard-2` (2 vCPU / 8 GB) is comfortable for ~80–150
  users; `e2-small` also works on a budget. (n4 requires a Hyperdisk Balanced
  boot disk — the default when you pick n4.)
- **OS:** Debian 12 or Ubuntu 22.04+.
- **Disk:** 30 GB is plenty.
- **Firewall:** tick "Allow HTTP traffic" and "Allow HTTPS traffic" (opens
  80/443). Leave everything else closed except SSH (22). MySQL/Redis are bound
  to `127.0.0.1` in compose and are never exposed.

### 2. Install Docker & fetch the repo

SSH into the VM, then:

```bash
sudo mkdir -p /opt/slihoot && sudo chown "$USER" /opt/slihoot
git clone <your-repo-url> /opt/slihoot
cd /opt/slihoot
```

### 3. Create production `.env`

```bash
cp .env.example .env
# Generate strong secrets:
echo "JWT_SECRET=$(openssl rand -hex 32)"            >> .env
echo "ADMIN_PASSWORD=$(openssl rand -base64 18)"     >> .env
echo "DB_PASSWORD=$(openssl rand -base64 18)"        >> .env
echo "MYSQL_ROOT_PASSWORD=$(openssl rand -base64 18)" >> .env
# Then edit .env: remove the now-duplicated default lines, and set your domain:
#   DOMAIN=quiz.example.com
nano .env
```

> If you set a real `DOMAIN`, point its DNS **A record** at the VM's external IP
> first — Caddy obtains a Let's Encrypt certificate on first start. Leave
> `DOMAIN` empty to serve plain HTTP on port 80 while testing.

### 4. Bring the stack up

```bash
# Installs Docker if missing, then builds + starts everything:
sudo APP_DIR=/opt/slihoot bash scripts/startup.sh
# (equivalent to: docker compose up -d --build)
```

Verify:

```bash
curl -s localhost:3000/healthz
docker compose ps
```

Then browse to `https://your-domain` (or `http://VM-IP`).

### 5. Auto-restart on VM reboot

Two complementary layers keep the service alive:

1. **systemd unit (primary — guarantees reboot recovery).** On boot, systemd
   starts Docker and then brings the whole compose project up. This works
   regardless of Docker's restart-policy behaviour, so it's the reliable path
   for "service comes back after a reboot":

   ```bash
   sudo systemctl enable --now docker
   sudo cp /opt/slihoot/deploy/slihoot.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now slihoot
   ```

   Now `sudo reboot` and the full stack comes back on its own. Manage it with
   `systemctl status/start/stop slihoot`. (Edit `WorkingDirectory` in the unit
   if your checkout isn't `/opt/slihoot`.)

2. **Container restart policy (crash recovery).** Every service uses
   `restart: unless-stopped`, so on a standard Docker Engine a container that
   crashes while the VM stays up is restarted automatically — without waiting
   for a reboot.

> Verify after setup with: `sudo reboot`, wait, then `curl -s localhost:3000/healthz`.

### 6. (Optional) Continuous deployment

`.github/workflows/deploy.yml` SSHes to the VM and rolls forward after CI passes
on `main`. In your GitHub repo settings add:

- Secrets: `DEPLOY_HOST` (VM IP), `DEPLOY_USER`, `DEPLOY_SSH_KEY` (a private key
  whose public half is in the VM user's `~/.ssh/authorized_keys`).
- Optional variable: `DEPLOY_DIR` (defaults to `/opt/slihoot`).

Each green build on `main` then runs `git pull --ff-only && docker compose up -d --build` on the VM.

## Useful scripts

```bash
bun run typecheck
bun run build
bun run start
bun run loadtest
```

---

## Music Credit

"Aurea Carmina", "Disco Medusae", "Ether Disco", "Stringed Disco", "Screen Saver" Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0 License
http://creativecommons.org/licenses/by/4.0/

"bell1", "bell2" arranged by gcoctopis
