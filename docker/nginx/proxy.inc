# Shared proxy settings for every API location.
proxy_pass http://wagering;
proxy_http_version 1.1;
proxy_set_header Connection "";          # upstream keep-alive
proxy_set_header Host $host;
# The edge is the first hop: client-supplied X-Forwarded-For/X-Real-IP are discarded, never trusted.
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Correlation-Id $correlation_id;
proxy_connect_timeout 2s;
proxy_read_timeout 30s;
proxy_send_timeout 10s;
proxy_next_upstream error timeout;      # nginx never retries POST (non-idempotent) on another replica
