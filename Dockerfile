# syntax=docker/dockerfile:1

# ---- build stage: install all deps and build the client bundle ----
FROM oven/bun:1.3.11 AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .
RUN bun run build

# ---- runtime stage: production deps + built assets only ----
FROM oven/bun:1.3.11-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Production dependencies only (skips typescript / @types/*).
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production

# Server source, SQL migrations and the built client bundle (vite copies
# public/ into dist).
COPY src ./src
COPY migrations ./migrations
COPY --from=build /app/dist ./dist

# Drop root privileges (the oven/bun image ships a non-root `bun` user).
USER bun

EXPOSE 3000
CMD ["bun", "src/server/index.ts"]
