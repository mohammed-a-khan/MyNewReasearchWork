#!/usr/bin/env bash
# OrangeHRM 5.7 + MariaDB 10.11 for test/acceptance/enterprise/orangehrm-ui-db.test.ts.
#
#   test/acceptance/enterprise/env/orangehrm.sh up      # an isolated pair of our own: web :18090, database :13316
#   test/acceptance/enterprise/env/orangehrm.sh env     # the variables for that pair
#   test/acceptance/enterprise/env/orangehrm.sh shared  # the variables for an existing pair (OHRM_CONTAINER, OHRM_DB_CONTAINER)
#   test/acceptance/enterprise/env/orangehrm.sh down    # remove our pair (never anything else)
#
# The isolated pair is installed with OrangeHRM's own CLI installer (installer/cli_install.php), admin "Admin" with
# the password below. Throwaway test values only.
set -euo pipefail

NET=ez-ent-ohrm-net
DB=ez-ent-ohrm-db
WEB=ez-ent-ohrm
WEB_PORT="${EZTEST_OHRM_PORT:-18090}"
DB_PORT="${EZTEST_OHRM_DB_PORT:-13316}"
ROOT_PW=EzOhrm_Root1
ADMIN_PW='Ez-Admin#2026'

image() {
  if docker image inspect "$1" >/dev/null 2>&1; then echo "$1"; return; fi
  if docker pull "$1" >/dev/null 2>&1; then echo "$1"; return; fi
  echo "mirror.gcr.io/library/$1"
}
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

up() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  if ! running "$DB"; then
    docker rm -f "$DB" >/dev/null 2>&1 || true
    docker run -d --name "$DB" --network "$NET" -p "$DB_PORT:3306" -e MARIADB_ROOT_PASSWORD="$ROOT_PW" "$(image mariadb:10.11)" >/dev/null
  fi
  for _ in $(seq 1 60); do
    docker exec "$DB" mariadb -uroot -p"$ROOT_PW" -e 'SELECT 1' >/dev/null 2>&1 && break
    sleep 2
  done
  if ! running "$WEB"; then
    docker rm -f "$WEB" >/dev/null 2>&1 || true
    docker run -d --name "$WEB" --network "$NET" -p "$WEB_PORT:80" orangehrm/orangehrm:5.7 >/dev/null
  fi
  if ! docker exec "$WEB" test -f /var/www/html/lib/confs/Conf.php; then
    cat > /tmp/ez-ent-ohrm-install.yaml <<YAML
database:
  hostName: $DB
  hostPort: 3306
  databaseName: orangehrm_app
  privilegedDatabaseUser: root
  privilegedDatabasePassword: $ROOT_PW
  useSameDbUserForOrangeHRM: y
  orangehrmDatabaseUser: ~
  orangehrmDatabasePassword: ~
  isExistingDatabase: n
  enableDataEncryption: n
organization:
  name: EZTest QA
  country: US
admin:
  adminUserName: Admin
  adminPassword: "$ADMIN_PW"
  adminEmployeeFirstName: QA
  adminEmployeeLastName: Admin
  workEmail: qa-admin@example.test
  contactNumber: ~
  registrationConsent: false
license:
  agree: y
YAML
    docker cp /tmp/ez-ent-ohrm-install.yaml "$WEB":/var/www/html/installer/cli_install_config.yaml
    rm -f /tmp/ez-ent-ohrm-install.yaml
    docker exec -w /var/www/html "$WEB" php installer/cli_install.php >/dev/null
    docker exec "$WEB" chown -R www-data:www-data /var/www/html/lib/confs /var/www/html/src/cache /var/www/html/src/log 2>/dev/null || true
  fi
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/web/index.php/auth/login" && break
    sleep 2
  done
  env_vars
}

env_vars() {
  echo "export EZTEST_ORANGEHRM_URL=http://127.0.0.1:$WEB_PORT"
  echo "export EZTEST_ORANGEHRM_PASSWORD='$ADMIN_PW'"
  echo "export EZTEST_ORANGEHRM_DB_URL=mysql://root:$ROOT_PW@127.0.0.1:$DB_PORT/orangehrm_app"
}

shared() {
  # An existing pair: its database container's address on its network, its published web port.
  local web="${OHRM_CONTAINER:-ohrm}" db="${OHRM_DB_CONTAINER:-ohrm-db}"
  local ip port
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$db")
  port=$(docker port "$web" 80/tcp | head -1 | sed 's/.*://')
  echo "export EZTEST_ORANGEHRM_URL=http://127.0.0.1:$port"
  echo "export EZTEST_ORANGEHRM_PASSWORD='${OHRM_ADMIN_PASSWORD:?set OHRM_ADMIN_PASSWORD to the admin password of that install}'"
  echo "export EZTEST_ORANGEHRM_DB_URL=mysql://root:${OHRM_DB_ROOT_PASSWORD:?set OHRM_DB_ROOT_PASSWORD}@$ip:3306/${OHRM_DB_NAME:-orangehrm_app}"
}

case "${1:-up}" in
  up) up ;;
  env) env_vars ;;
  shared) shared ;;
  down) docker rm -f "$WEB" "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up|env|shared|down" >&2; exit 2 ;;
esac
