#!/bin/sh
# Build and (re)start My NAB using plain docker commands, so it works with the
# older Synology "Docker" package (no Project/compose screen). Safe to re-run
# for every update: it replaces the container but never touches ./data.
#
#   sudo ./deploy.sh              (host port 8080, NAS-local only)
#   sudo HOST_PORT=9090 ./deploy.sh
set -e
cd "$(dirname "$0")"

# sudo resets PATH on Synology, and the Docker package keeps its binary outside
# the default one, so add the usual locations.
PATH="$PATH:/usr/local/bin:/var/packages/Docker/target/usr/bin:/var/packages/ContainerManager/target/usr/bin:/volume1/@appstore/Docker/usr/bin"
export PATH
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found. Find it with:  sudo find /usr /var/packages /volume1/@appstore -name docker -type f 2>/dev/null" >&2
  exit 1
fi

NAME=my-nab
HOST_PORT="${HOST_PORT:-8080}"
DATA="$(pwd)/data"
mkdir -p "$DATA"

docker build -t "$NAME" .
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p "127.0.0.1:${HOST_PORT}:8000" \
  -e NAB_HTTPS=1 \
  -e NAB_DB_PATH=/data/nab.db \
  -v "$DATA":/data \
  "$NAME"

echo
echo "Started. Check it with:  curl -s http://127.0.0.1:${HOST_PORT}/api/session"
