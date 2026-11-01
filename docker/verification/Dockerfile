FROM docker:29.0.0-cli@sha256:87858a6dd14149240f4a2c33e0ec0f32a5ac1bb2548c04f5a20694ea25cb6157 AS docker
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

# Git and the Docker client let GNU parallel run the actual repository suite against
# the same local daemon. util-linux supplies the PTY required by pg_activity.
RUN apt-get update && apt-get install --no-install-recommends -y \
    ca-certificates coreutils curl git parallel pg-activity postgresql-client \
    stress-ng tcpdump util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV BUN_CONFIG_NO_ENV_FILE=true BUN_CONFIG_NO_AUTO_INSTALL=true TZ=UTC
WORKDIR /tmp
CMD ["bun", "--version"]
