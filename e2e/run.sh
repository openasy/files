#!/bin/bash
# End to end against a real OpenCloud: starts the version compose.yaml pins in Docker with the settings Files relies
# on, makes the service account's app token as the README does, then e2e/opencloud.ts runs Files' server against it.
# Needs Docker. Exits non-zero on failure.
set -u
cd "$(dirname "$0")/.."
IMAGE=$(sed -n 's/^ *image: \(opencloudeu\/opencloud:[^ ]*\).*$/\1/p' compose.yaml)
PORT=${E2E_OC_PORT:-19200}
NAME=files-e2e-oc
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; }
cleanup
AUDIT=$(mktemp -d)
chmod 777 "$AUDIT"
[ -n "${E2E_KEEP:-}" ] || trap 'cleanup; rm -rf "$AUDIT"' EXIT
# OpenCloud's own identity provider runs here, since there is no Identity to sign in through; everything else is as in
# compose.yaml. The audit log goes to a folder this script reads, as the opencloud-audit volume does for Files.
# OpenCloud sends uploads on to itself at OC_URL, so it listens inside on the same port as outside.
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:$PORT" -e PROXY_HTTP_ADDR="0.0.0.0:$PORT" -v "$AUDIT:/var/lib/opencloud-audit" --entrypoint /bin/sh \
  -e OC_URL="https://localhost:$PORT" -e OC_INSECURE=true -e IDM_CREATE_DEMO_USERS=false \
  -e STORAGE_USERS_DRIVER=posix -e PROXY_ENABLE_APP_AUTH=true -e AUTH_APP_ENABLE_IMPERSONATION=true \
  -e GRAPH_USERNAME_MATCH=none -e GRAPH_ASSIGN_DEFAULT_USER_ROLE=true \
  -e OC_ADD_RUN_SERVICES=audit -e AUDIT_LOG_TO_FILE=true -e AUDIT_LOG_TO_CONSOLE=false -e AUDIT_FORMAT=json \
  -e AUDIT_FILEPATH=/var/lib/opencloud-audit/audit.log -e OC_SHARING_PUBLIC_SHARE_MUST_HAVE_PASSWORD=true \
  "$IMAGE" -c "opencloud init --insecure true --admin-password e2e-admin-password >/dev/null || true; opencloud server" >/dev/null
for _ in $(seq 1 120); do curl -sfk "https://localhost:$PORT/status.php" >/dev/null && break; sleep 1; done
curl -sfk "https://localhost:$PORT/status.php" >/dev/null || { echo "OpenCloud did not start"; docker logs --tail 20 "$NAME"; exit 1; }
# Its services come up one after another after status.php answers: the app token needs auth-app.
TOKEN=""
for _ in $(seq 1 60); do
  TOKEN=$(docker exec "$NAME" opencloud auth-app create --user-name=admin --expiration=2h 2>/dev/null | sed -n 's/^ *token: //p')
  [ -n "$TOKEN" ] && break
  sleep 2
done
[ -n "$TOKEN" ] || { echo "No app token for admin"; docker logs --tail 20 "$NAME"; exit 1; }
echo "# $IMAGE on port $PORT"
OC="https://localhost:$PORT" OC_TOKEN="$TOKEN" OC_AUDIT="$AUDIT/audit.log" NODE_TLS_REJECT_UNAUTHORIZED=0 node e2e/opencloud.ts
status=$?
[ $status -eq 0 ] || docker logs --tail 40 "$NAME"
exit $status
