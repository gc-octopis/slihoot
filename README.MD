# Slihoot

The combination of Slido, Kahoot, and more.

Slihoot is a self-hosted live interaction web app. The first MVP supports admin event editing, live sessions, participant join codes, real-time answers, result display, and a lightweight Q&A message wall.

## MVP Features

- Single admin login with `ADMIN_PASSWORD`.
- Event CRUD and activity editing.
- Activity types: multiple choice, true/false, short answer.
- Live session start/end with join code.
- Participant join with nickname and local token recovery.
- WebSocket state sync for current activity, answer counts, and results.
- Q&A messages with admin hide/show/delete/pin moderation.
- MySQL persistence and Docker Compose setup.

## Local Development

Install dependencies:

```bash
bun install
```

Create environment variables:

```bash
cp .env.example .env
```

Start MySQL with Docker:

```bash
docker compose up mysql
```

Start the backend:

```bash
bun run dev
```

Start the Vite frontend in another terminal:

```bash
bun run dev:web
```

Open:

- Participant entry: `http://localhost:5173/`
- Admin login: `http://localhost:5173/admin`

## Join from a phone

If you share a join link using `localhost`, phones can't open it. Use either:

1) Same Wi‑Fi / LAN: run `bun run dev:web` (it starts Vite with `--host 0.0.0.0`) and share `http://<your-lan-ip>:5173/`.

2) Different networks (no router/NAT setup): install `cloudflared` and start a free quick tunnel from the host UI.

Windows install:

```bash
winget install -e --id Cloudflare.cloudflared
```

After install, restart the backend (`bun run dev`) so it can pick up the updated PATH. Then go to the Admin Live page → `QR Code` → `Cloudflare Quick Tunnel` → `Start`, and share the generated `https://*.trycloudflare.com` link / QR.

## Docker

Run the full MVP stack:

```bash
docker compose up --build
```

The app will be available at:

```text
http://localhost:3000
```

## Useful Scripts

```bash
bun run typecheck
bun run build
bun run start
```

---

## Music Credit

"Aurea Carmina", "Disco Medusae", "Ether Disco", "Stringed Disco", "Screen Saver" Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0 License
http://creativecommons.org/licenses/by/4.0/

"bell1", "bell2" arranged by gcoctopis
