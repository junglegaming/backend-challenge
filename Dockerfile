FROM oven/bun:1.4

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# bun recebe o SIGTERM direto (sem shell no meio) → shutdown gracioso dos workers
CMD ["bun", "run", "src/main.ts"]
