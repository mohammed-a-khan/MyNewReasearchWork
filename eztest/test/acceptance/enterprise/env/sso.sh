#!/usr/bin/env bash
# A corporate single sign-on front door, like Citrix NetScaler / F5 / an SSO gateway, for
# test/acceptance/enterprise/gateway-sso.test.ts:
#
#   http://app.ez.test:14180      oauth2-proxy 7.7 (the gateway) in front of the Expenses app (env/sso/expenses-app.mjs),
#                                 its sessions kept server-side in Redis (sign-out and time-outs end them for good)
#   http://gateway.ez.test:18180  Keycloak 26 (the identity provider), realm "corp" from env/sso/realm-corp.json:
#                                 ada (password), grace (password + TOTP), linus (password + a Terms page)
#
#   test/acceptance/enterprise/env/sso.sh up     # hosts entries (when /etc/hosts is writable), network, three containers
#   test/acceptance/enterprise/env/sso.sh env    # the variables the test reads
#   test/acceptance/enterprise/env/sso.sh expire # end every gateway session (as a server-side time-out does)
#   test/acceptance/enterprise/env/sso.sh down   # remove these containers and the network (only these)
#
# Two host names on two ports make the gateway a different origin from the app, as in production. When /etc/hosts
# cannot be changed, add "127.0.0.1 gateway.ez.test app.ez.test" to it yourself (the test skips otherwise).
# All passwords and secrets are throwaway test values.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NET=ez-sso-net
KC=ez-sso-keycloak
PROXY=ez-sso-gateway
APP=ez-sso-expenses
REDIS=ez-sso-redis
KC_IMAGE="${EZTEST_KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.0}"
PROXY_IMAGE="${EZTEST_OAUTH2_PROXY_IMAGE:-quay.io/oauth2-proxy/oauth2-proxy:v7.7.1}"
NODE_IMAGE="${EZTEST_NODE_IMAGE:-node:22-bookworm-slim}"
REDIS_IMAGE="${EZTEST_REDIS_IMAGE:-redis:7-alpine}"
GW_HOST=gateway.ez.test
APP_HOST=app.ez.test
KC_PORT=18180
APP_PORT=14180
CLIENT_SECRET=ez-expenses-gateway-secret
COOKIE_SECRET=ezGatewayCookieSecret0123456789A   # 32 bytes

image() {
  if docker image inspect "$1" >/dev/null 2>&1; then echo "$1"; return; fi
  if docker pull "$1" >/dev/null 2>&1; then echo "$1"; return; fi
  echo "mirror.gcr.io/library/$1"
}
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

hosts() {
  if getent hosts "$GW_HOST" >/dev/null && getent hosts "$APP_HOST" >/dev/null; then return; fi
  if [ -w /etc/hosts ]; then
    printf '127.0.0.1 %s %s  # EZTest gateway acceptance test\n' "$GW_HOST" "$APP_HOST" >> /etc/hosts
  else
    echo "add '127.0.0.1 $GW_HOST $APP_HOST' to /etc/hosts" >&2
    exit 1
  fi
}

up() {
  hosts
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  if ! running "$KC"; then
    docker rm -f "$KC" >/dev/null 2>&1 || true
    # The browser reaches Keycloak at http://gateway.ez.test:18180; the gateway talks to it on the private network
    # (backchannel), and the tokens name the public URL as their issuer.
    docker run -d --name "$KC" --network "$NET" -p "$KC_PORT:8080" \
      -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=EzKcAdmin_1 \
      -v "$HERE/sso/realm-corp.json:/opt/keycloak/data/import/realm-corp.json:ro" \
      "$KC_IMAGE" start-dev --import-realm --hostname="http://$GW_HOST:$KC_PORT" --hostname-backchannel-dynamic=true >/dev/null
  fi
  if ! running "$REDIS"; then
    docker rm -f "$REDIS" >/dev/null 2>&1 || true
    docker run -d --name "$REDIS" --network "$NET" "$(image "$REDIS_IMAGE")" >/dev/null
  fi
  if ! running "$APP"; then
    docker rm -f "$APP" >/dev/null 2>&1 || true
    local kc_logout="http://$GW_HOST:$KC_PORT/realms/corp/protocol/openid-connect/logout?client_id=expenses&post_logout_redirect_uri=http%3A%2F%2F$APP_HOST%3A$APP_PORT%2F"
    local rd
    rd=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$kc_logout" 2>/dev/null || python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""),end="")' "$kc_logout")
    docker run -d --name "$APP" --network "$NET" -e PORT=8080 -e "LOGOUT_URL=/oauth2/sign_out?rd=$rd" \
      -v "$HERE/sso/expenses-app.mjs:/srv/app.mjs:ro" "$(image "$NODE_IMAGE")" node /srv/app.mjs >/dev/null
  fi
  for _ in $(seq 1 90); do
    curl -fs -o /dev/null "http://127.0.0.1:$KC_PORT/realms/corp/.well-known/openid-configuration" && break
    sleep 2
  done
  if ! running "$PROXY"; then
    docker rm -f "$PROXY" >/dev/null 2>&1 || true
    docker run -d --name "$PROXY" --network "$NET" -p "$APP_PORT:4180" "$PROXY_IMAGE" \
      --http-address=0.0.0.0:4180 --provider=oidc --client-id=expenses --client-secret="$CLIENT_SECRET" \
      --oidc-issuer-url="http://$GW_HOST:$KC_PORT/realms/corp" --skip-oidc-discovery \
      --login-url="http://$GW_HOST:$KC_PORT/realms/corp/protocol/openid-connect/auth" \
      --redeem-url="http://$KC:8080/realms/corp/protocol/openid-connect/token" \
      --oidc-jwks-url="http://$KC:8080/realms/corp/protocol/openid-connect/certs" \
      --redirect-url="http://$APP_HOST:$APP_PORT/oauth2/callback" --upstream="http://$APP:8080/" \
      --email-domain='*' --cookie-secret="$COOKIE_SECRET" --cookie-secure=false --cookie-name=_ez_gateway --cookie-expire=8h \
      --skip-provider-button=true --pass-user-headers=true --insecure-oidc-allow-unverified-email=true \
      --code-challenge-method=S256 --whitelist-domain="$GW_HOST:$KC_PORT" --scope='openid email profile' \
      --session-store-type=redis --redis-connection-url="redis://$REDIS:6379" >/dev/null
  fi
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/ping")" = "200" ] && break
    sleep 1
  done
  env_vars
}

env_vars() {
  echo "export EZTEST_GATEWAY_APP_URL=http://$APP_HOST:$APP_PORT"
  echo "export EZTEST_GATEWAY_IDP_URL=http://$GW_HOST:$KC_PORT"
}

case "${1:-up}" in
  up) up ;;
  env) env_vars ;;
  expire) docker exec "$REDIS" redis-cli FLUSHALL >/dev/null ;;   # every gateway session times out at once
  down) docker rm -f "$PROXY" "$APP" "$KC" "$REDIS" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up|env|expire|down" >&2; exit 2 ;;
esac
