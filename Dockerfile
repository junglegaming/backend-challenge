# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
# tsconfig.json is read by Bun at runtime (decorator metadata for NestJS DI).
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# Tracing is preloaded so pg/http instrumentation hooks in before the app imports them (no-op unless OTEL_ENABLED=true).
CMD ["bun", "--preload", "./src/infrastructure/observability/tracing.ts", "src/main.ts"]
