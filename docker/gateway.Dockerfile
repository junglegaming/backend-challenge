# nginx with the config baked in: no bind mount, so it behaves the same on
# Linux (incl. SELinux), macOS and Windows.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
