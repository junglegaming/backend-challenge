FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun x nest build
FROM oven/bun:1.4.4
WORKDIR /app
COPY --from=build /app ./
EXPOSE 3000
CMD ["bun", "dist/src/main.js"]
