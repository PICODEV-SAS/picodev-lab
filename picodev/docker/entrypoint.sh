#!/bin/bash
# Container entrypoint: backend (uvicorn) + nginx, nothing downloaded at boot.
set -euo pipefail

# The deployment file (PICODEV_CONFIG, optional) feeds the editor and nginx too.
# A file that is named but missing or invalid stops the container here.
mkdir -p /etc/nginx/lab
python /app/render_config.py "${PICODEV_CONFIG:-}" \
  /usr/share/nginx/html/config.js /etc/nginx/conf.d/00-lab-zones.conf /etc/nginx/lab/server.inc
nginx -t -q

# Velxio silently skips app.pro when it fails to import; a restricted instance
# would then run with no limits at all. Fail loudly instead.
python -c "import app.pro" || { echo "FATAL: overlay (app.pro) does not import" >&2; exit 1; }

# The container log keeps errors only (WARNING and up), never a client address
# nor code: no access log, every logger at WARNING from before Velxio is
# imported (logging.json, to stderr), and stdout dropped, where Velxio prints
# arduino-cli's output (compiler errors quote the sketch).
# --proxy-headers stays: the backend rate limit needs the client address.
uvicorn app.main:app --host 127.0.0.1 --port 8001 --proxy-headers \
  --no-access-log --log-level warning --log-config /app/logging.json >/dev/null &
UVICORN_PID=$!
sleep 2
nginx -g "daemon off;" &
NGINX_PID=$!

set +e
wait -n "$UVICORN_PID" "$NGINX_PID"
EXIT_CODE=$?
echo "A process exited (code $EXIT_CODE), stopping the container" >&2
kill "$UVICORN_PID" "$NGINX_PID" 2>/dev/null || true
exit "$EXIT_CODE"
