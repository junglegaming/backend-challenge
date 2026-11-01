FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
# Generate disposable certificates without host tools or a versioned private key.
# This integration-test image never enters the application.
RUN apt-get update && apt-get install --no-install-recommends -y openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /fixtures
ENTRYPOINT ["sh", "-ec"]
