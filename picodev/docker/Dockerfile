# Velxio (this repository) + the overlay of picodev/: an image whose editor,
# limits and refused routes are set at run time by one deployment file
# (PICODEV_CONFIG, see picodev/config/lab.example.toml). Without that file it
# runs as stock Velxio.
# Build from the repository root:
#   docker build -f picodev/docker/Dockerfile -t picodev-lab:dev .
#
# Only the toolchain is fixed at build time, because the running container
# downloads nothing. Space-separated, each entry pinned as name@version; pass
# the [toolchain] lists of the deployment file:
#   --build-arg ARDUINO_CORES="arduino:avr@1.8.6" --build-arg ARDUINO_LIBS="Servo@1.2.2"
ARG ARDUINO_CLI_VERSION=1.1.1
ARG ARDUINO_CORES="arduino:avr@1.8.6"
ARG ARDUINO_LIBS=""

# ---- Stage 1: editor (Vite build with the overlay plugged into @pro) ----
FROM node:20-bookworm AS frontend
WORKDIR /app
COPY frontend/ frontend/
COPY scripts/ scripts/
# The overlay is copied inside src/ (not symlinked) so that its imports resolve
# against the editor's node_modules; vite.config.ts points @pro at it.
COPY picodev/frontend/pro/ frontend/src/pro/
WORKDIR /app/frontend
ENV VITE_PRO_BUILD=true \
    PRO_OVERLAY_PATH=src/pro
# --legacy-peer-deps: npm 10 aborts on the jsdom/canvas optional peer otherwise
RUN rm -f package-lock.json \
 && npm install --include=optional --no-audit --no-fund --legacy-peer-deps \
 && npm run build:docker

# ---- Stage 2: runtime (FastAPI backend + nginx, arduino-cli with the listed cores) ----
FROM python:3.12-slim
ARG ARDUINO_CLI_VERSION
ARG ARDUINO_CORES
ARG ARDUINO_LIBS

RUN apt-get update && apt-get install -y --no-install-recommends nginx curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# arduino-cli, the cores and the libraries are installed at build time: the
# running container never downloads toolchains or libraries.
RUN curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/arduino-cli_${ARDUINO_CLI_VERSION}_Linux_64bit.tar.gz" \
      | tar -xz -C /usr/local/bin arduino-cli \
 && arduino-cli config init \
 && arduino-cli core update-index \
 && for core in ${ARDUINO_CORES}; do arduino-cli core install "$core"; done \
 && for lib in ${ARDUINO_LIBS}; do arduino-cli lib install "$lib"; done \
 && arduino-cli core list && arduino-cli lib list

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app/ ./app/
COPY picodev/backend/pro/ ./app/pro/

RUN rm -f /etc/nginx/sites-enabled/default
COPY picodev/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY picodev/docker/nginx-app.conf /etc/nginx/lab-app.conf
COPY --from=frontend /app/frontend/dist /usr/share/nginx/html
COPY picodev/docker/entrypoint.sh picodev/docker/render_config.py picodev/docker/logging.json /app/
COPY picodev/docker/externalize_scripts.py /tmp/
# No inline script left in the pages: a CSP "script-src 'self'" needs no hash.
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh \
 && python /tmp/externalize_scripts.py /usr/share/nginx/html && rm /tmp/externalize_scripts.py

ENV VELXIO_NEWS=off \
    VELXIO_COMPILE_TIMEOUT=60 \
    VELXIO_HEAVY_BUILD_SLOTS=1 \
    VELXIO_LIGHT_BUILD_SLOTS=2 \
    PYTHONUNBUFFERED=1

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1/health || exit 1
CMD ["/app/entrypoint.sh"]
