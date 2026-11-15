# ---- production dependencies only
FROM oven/bun:1.2.23 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- test image: full dependencies + test suite (docker compose run --rm tests)
FROM oven/bun:1.2.23 AS test
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
CMD ["bun", "test", "--timeout", "180000"]

# ---- runtime image (default target)
FROM oven/bun:1.2.23 AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
# exec form: bun is PID 1 and receives SIGTERM directly (graceful drain)
CMD ["bun", "src/main.ts"]
