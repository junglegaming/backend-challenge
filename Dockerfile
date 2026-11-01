FROM oven/bun:1.4.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
USER bun
ENV TZ=UTC
EXPOSE 3000
CMD ["bun", "src/main.ts"]
