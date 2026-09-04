#!/usr/bin/env bash
# Manage TransparentLC cloud-clipboard on this host.
set -euo pipefail
ROOT=/home/docker/cloud-clipboard
NAME=cloud-clipboard
IMAGE=cloud-clipboard:with-7z
BASE_IMAGE=jonnyan404/cloud-clipboard:latest
PORT=9501
AUTH_FILE="$ROOT/auth.txt"

ensure_image() {
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Building $IMAGE (adds p7zip for rar/7z preview)..."
    docker build -t "$IMAGE" -f "$ROOT/Dockerfile.local" "$ROOT"
  fi
}

cmd=${1:-status}
case "$cmd" in
  build)
    docker build -t "$IMAGE" -f "$ROOT/Dockerfile.local" "$ROOT"
    ;;
  start)
    ensure_image
    mkdir -p "$ROOT/data"
    if [ ! -f "$AUTH_FILE" ]; then
      openssl rand -base64 9 | tr -d '/+=' | head -c 12 > "$AUTH_FILE"
      chmod 600 "$AUTH_FILE"
    fi
    AUTH_PASS=$(tr -d '\n' < "$AUTH_FILE")
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d \
      --name "$NAME" \
      --restart=always \
      -p ${PORT}:9501 \
      -v "$ROOT/data:/app/server-node/data" \
      -v "$ROOT/antd-ui/dist:/app/server-node/static:ro" \
      -v "$ROOT/server-patch/http-router.js:/app/server-node/app/http-router.js:ro" \
      -v "$ROOT/server-patch/archive-list.js:/app/server-node/app/archive-list.js:ro" \
      -v "$ROOT/server-patch/uploaded-file.js:/app/server-node/app/uploaded-file.js:ro" \
      -e LISTEN_IP=0.0.0.0 \
      -e LISTEN_PORT=9501 \
      -e AUTH_PASSWORD="\"${AUTH_PASS}\"" \
      -e MESSAGE_NUM=50 \
      -e TEXT_LIMIT=204800 \
      -e FILE_LIMIT=10737418240 \
      -e FILE_EXPIRE=0 \
      "$IMAGE"
    ;;
  stop)
    docker stop "$NAME" || true
    ;;
  restart)
    docker restart "$NAME"
    ;;
  logs)
    docker logs --tail "${2:-100}" -f "$NAME"
    ;;
  auth)
    if [ -f "$AUTH_FILE" ]; then
      echo "password: $(tr -d '\n' < "$AUTH_FILE")"
    else
      echo "no auth file"
      exit 1
    fi
    ;;
  status)
    docker ps -a --filter name=^/${NAME}$ --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    curl -sS -o /dev/null -w 'local_http:%{http_code}\n' --connect-timeout 3 "http://127.0.0.1:${PORT}/" || true
    [ -f "$AUTH_FILE" ] && echo "auth_file:$AUTH_FILE"
    ;;
  *)
    echo "Usage: $0 {build|start|stop|restart|logs|status|auth}"
    exit 1
    ;;
esac
