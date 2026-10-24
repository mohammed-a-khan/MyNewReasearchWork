#!/usr/bin/env bash
# MariaDB 10.11 and MySQL 8.4 for the MySQL wire-protocol tests (test/integration/mysql-*.test.ts).
#
#   test/acceptance/enterprise/env/mysql.sh up       # start (or reuse) both containers, wait until they accept logins
#   test/acceptance/enterprise/env/mysql.sh env      # print the variables the tests read
#   test/acceptance/enterprise/env/mysql.sh down     # remove the two containers (only these two)
#
# Both servers get TLS certificates from a private CA made here (CN=localhost, SAN localhost and 127.0.0.1), so the
# tests can verify the server certificate. Users (all passwords are throwaway test values):
#   MariaDB  :13306  eztest / EzMaria_1        mysql_native_password
#   MySQL    :13307  eztest / EzMysql_1        caching_sha2_password (the 8.4 default)
#                    ez_native / EzNative_1    mysql_native_password (enabled with --mysql-native-password=ON)
#                    ez_tls / EzTls_1          caching_sha2_password, REQUIRE SSL
set -euo pipefail

STATE="${EZTEST_ENV_DIR:-$HOME/.cache/eztest-enterprise-env}/mysql"
MARIA=ez-ent-mariadb
MYSQL=ez-ent-mysql84
MARIA_PORT="${EZTEST_MARIADB_PORT:-13306}"
MYSQL_PORT="${EZTEST_MYSQL_PORT:-13307}"

# Docker Hub images, or the same images from Google's mirror when Docker Hub rate-limits pulls.
image() {
  if docker image inspect "$1" >/dev/null 2>&1; then echo "$1"; return; fi
  if docker pull "$1" >/dev/null 2>&1; then echo "$1"; return; fi
  echo "mirror.gcr.io/library/$1"
}

certs() {
  mkdir -p "$STATE/certs" "$STATE/init-maria" "$STATE/init-mysql"
  cd "$STATE/certs"
  if [ ! -f server-cert.pem ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=EZTest test CA" -keyout ca-key.pem -out ca.pem 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server-key.pem -out server.csr 2>/dev/null
    printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > san.ext
    openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3650 -extfile san.ext -out server-cert.pem 2>/dev/null
    # The server processes run as the mysql user inside the containers.
    chmod 644 ./*.pem
  fi
  cat > "$STATE/init-maria/01-users.sql" <<'SQL'
CREATE USER IF NOT EXISTS 'eztest'@'%' IDENTIFIED BY 'EzMaria_1';
GRANT ALL PRIVILEGES ON eztest.* TO 'eztest'@'%';
FLUSH PRIVILEGES;
SQL
  cat > "$STATE/init-mysql/01-users.sql" <<'SQL'
CREATE USER IF NOT EXISTS 'eztest'@'%' IDENTIFIED WITH caching_sha2_password BY 'EzMysql_1';
CREATE USER IF NOT EXISTS 'ez_native'@'%' IDENTIFIED WITH mysql_native_password BY 'EzNative_1';
CREATE USER IF NOT EXISTS 'ez_tls'@'%' IDENTIFIED WITH caching_sha2_password BY 'EzTls_1' REQUIRE SSL;
GRANT ALL PRIVILEGES ON eztest.* TO 'eztest'@'%', 'ez_native'@'%', 'ez_tls'@'%';
FLUSH PRIVILEGES;
SQL
  cd - >/dev/null
}

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

wait_login() { # container, user, password
  for _ in $(seq 1 90); do
    if docker exec "$1" sh -c "command -v mariadb >/dev/null && exec mariadb -h127.0.0.1 -u$2 -p$3 -e 'SELECT 1' || exec mysql -h127.0.0.1 -u$2 -p$3 -e 'SELECT 1'" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "timed out waiting for $1" >&2
  return 1
}

up() {
  certs
  if ! running "$MARIA"; then
    docker rm -f "$MARIA" >/dev/null 2>&1 || true
    docker run -d --name "$MARIA" -p "$MARIA_PORT:3306" \
      -e MARIADB_ROOT_PASSWORD=EzMaria_Root1 -e MARIADB_DATABASE=eztest \
      -v "$STATE/certs:/etc/mysql/eztest-certs:ro" -v "$STATE/init-maria:/docker-entrypoint-initdb.d:ro" \
      "$(image mariadb:10.11)" \
      --ssl-ca=/etc/mysql/eztest-certs/ca.pem --ssl-cert=/etc/mysql/eztest-certs/server-cert.pem --ssl-key=/etc/mysql/eztest-certs/server-key.pem \
      --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null
  fi
  if ! running "$MYSQL"; then
    docker rm -f "$MYSQL" >/dev/null 2>&1 || true
    docker run -d --name "$MYSQL" -p "$MYSQL_PORT:3306" \
      -e MYSQL_ROOT_PASSWORD=EzMysql_Root1 -e MYSQL_DATABASE=eztest \
      -v "$STATE/certs:/etc/mysql/eztest-certs:ro" -v "$STATE/init-mysql:/docker-entrypoint-initdb.d:ro" \
      "$(image mysql:8.4)" \
      --mysql-native-password=ON \
      --ssl-ca=/etc/mysql/eztest-certs/ca.pem --ssl-cert=/etc/mysql/eztest-certs/server-cert.pem --ssl-key=/etc/mysql/eztest-certs/server-key.pem >/dev/null
  fi
  wait_login "$MARIA" eztest EzMaria_1
  wait_login "$MYSQL" eztest EzMysql_1
  env_vars
}

env_vars() {
  echo "export EZTEST_MARIADB_URL=mysql://eztest:EzMaria_1@127.0.0.1:$MARIA_PORT/eztest"
  echo "export EZTEST_MYSQL_URL=mysql://eztest:EzMysql_1@127.0.0.1:$MYSQL_PORT/eztest"
  echo "export EZTEST_MYSQL_CA=$STATE/certs/ca.pem"
}

case "${1:-up}" in
  up) up ;;
  env) env_vars ;;
  down) docker rm -f "$MARIA" "$MYSQL" >/dev/null 2>&1 || true ;;
  *) echo "usage: $0 up|env|down" >&2; exit 2 ;;
esac
