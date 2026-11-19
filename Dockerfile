# ChronoCut as a container: build the static web app, serve it with nginx.
# Everything (PDF reading, time estimate, PDF export) runs in the visitor's
# browser - the container only hands out files, it never sees a drawing.
#
#   docker build -t chronocut .
#   docker run -d --name chronocut -p 8080:8080 --restart unless-stopped chronocut
#
# or: docker compose up -d   (see compose.yaml)

# ── 1. Build ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm ci --prefix frontend
COPY frontend frontend
COPY printers printers
RUN npm run build --prefix frontend

# ── 2. Serve ─────────────────────────────────────────────────────────────────
# Unprivileged nginx: runs as a normal user and listens on 8080, not 80.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
