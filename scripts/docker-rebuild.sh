#!/usr/bin/env bash
# Rebuild the local Docker image and recreate the mcd-brackets container.
#
# Builds through a buildx builder with fixed DNS servers, because Docker Desktop's
# container DNS is unreliable on some machines (npm ci then hangs forever).
#
# Env overrides: PORT (host port, default 3001), CONTAINER (default mcd-brackets)
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3001}"
CONTAINER="${CONTAINER:-mcd-brackets}"
BUILDER="mcd-dns"
VERSION="$(node -p "require('./package.json').version")"
DATA_DIR="$(pwd)/data"

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "▶ Creating buildx builder '$BUILDER' with fixed DNS"
  docker buildx create --name "$BUILDER" --driver docker-container \
    --buildkitd-config scripts/buildkitd.toml >/dev/null
fi

echo "▶ Building mcd-brackets:$VERSION"
docker buildx build --builder "$BUILDER" --load \
  -t mcd-brackets:latest -t "mcd-brackets:$VERSION" .

echo "▶ Recreating container '$CONTAINER' on port $PORT (data: $DATA_DIR)"
mkdir -p "$DATA_DIR"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -p "$PORT:3000" \
  -v "$DATA_DIR:/app/data" \
  -e NODE_ENV=production \
  --restart unless-stopped \
  mcd-brackets:latest >/dev/null

echo -n "▶ Waiting for health check"
for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ]; then
    echo " ✔"
    echo "✅ mcd-brackets $VERSION läuft auf http://localhost:$PORT"
    exit 0
  fi
  echo -n "."
  sleep 2
done

echo " ✘ ($status)"
docker logs --tail 20 "$CONTAINER"
exit 1
