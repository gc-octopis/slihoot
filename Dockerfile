FROM oven/bun:1.3.11

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .
RUN bun run build

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "src/server/index.ts"]

