# Demo quick start

Use a fresh checkout on Ubuntu 24.04 with Bash, Git, sudo, and the version of
Node (with npm) in [`.nvmrc`](../.nvmrc). CI selects Node from the same file.
Run the commands from the repository root in one Bash session. Ports 55432,
8787, and 4321 must be free. Use only the synthetic listings and invented form
values. Both servers listen on loopback.

CI runs the shell blocks marked `ci` in order on a fresh runner.

## Install

```bash ci
git rev-parse HEAD
cat /etc/os-release
test "$(node --version)" = "v$(cat .nvmrc)"
node --version
npm --version
npm ci
npx playwright --version
npx playwright install --with-deps chromium

sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl postgresql-common
echo 'create_main_cluster = false' | sudo tee -a /etc/postgresql-common/createcluster.conf
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get install -y --no-install-recommends postgresql-18
export PATH="/usr/lib/postgresql/18/bin:$PATH"
postgres_version=$(postgres --version)
echo "$postgres_version"
[[ "$postgres_version" == "postgres (PostgreSQL) 18."* ]]
```

## Create the database, load listings, and make a site key

The temporary directory holds the cluster, socket, logs, and protected key.
The migration role owns the database. The engine uses the separate runtime
role, which gets read access to listings and permission to save inquiries.

```bash ci
export IDX_DEMO_DIR="$(mktemp -d)"
export IDX_TEST_LOG_DIR="$IDX_DEMO_DIR/test-logs"
unset RESEND_API_KEY INQUIRY_EMAIL_FROM INQUIRY_EMAIL_TO TURNSTILE_SECRET_KEY IDX_RUNTIME

demo_db_start() {
  pg_ctl -D "$IDX_DEMO_DIR/pg" -l "$IDX_DEMO_DIR/postgres.log" \
    -o "-h 127.0.0.1 -p 55432 -k $IDX_DEMO_DIR" -w start
}
demo_db_stop() {
  pg_ctl -D "$IDX_DEMO_DIR/pg" -m fast -w stop
}
demo_cleanup() {
  if [ -f "$IDX_DEMO_DIR/pg/postmaster.pid" ]; then
    demo_db_stop
  fi
  rm -r -- "$IDX_DEMO_DIR"
}
trap demo_cleanup EXIT

initdb -D "$IDX_DEMO_DIR/pg" --auth-local=trust --auth-host=scram-sha-256 \
  --username=postgres --locale=C --encoding=UTF8
demo_db_start

export IDX_MIGRATION_PASSWORD="$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')"
export IDX_RUNTIME_PASSWORD="$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')"
psql -X -h "$IDX_DEMO_DIR" -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password IDX_MIGRATION_PASSWORD
\getenv runtime_password IDX_RUNTIME_PASSWORD
CREATE ROLE idx_migration LOGIN PASSWORD :'migration_password';
CREATE ROLE idx_runtime LOGIN PASSWORD :'runtime_password';
CREATE DATABASE idx_demo OWNER idx_migration;
\connect idx_demo
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
server_version_num=$(PGPASSWORD="$IDX_RUNTIME_PASSWORD" \
  psql -X -h 127.0.0.1 -p 55432 -U idx_runtime -d idx_demo -Atc 'SHOW server_version_num')
echo "server_version_num=$server_version_num"
[[ "$server_version_num" =~ ^18[0-9]{4}$ ]]
export DATABASE_URL="postgresql://idx_migration:$IDX_MIGRATION_PASSWORD@127.0.0.1:55432/idx_demo"
export RUNTIME_DATABASE_URL="postgresql://idx_runtime:$IDX_RUNTIME_PASSWORD@127.0.0.1:55432/idx_demo"
unset IDX_MIGRATION_PASSWORD IDX_RUNTIME_PASSWORD
npm run demo:db:migrate
npm run demo:seed
npm run demo:key -- create site_demo_primary listings:read,inquiries:write,inquiries:read "$IDX_DEMO_DIR/site.secret"
npm run demo:site:build
```

## Start the servers and verify the demo

Define the commands below. Each replaces its shell with the server process so
the process can be stopped by its PID.

```bash ci
demo_engine() {
  unset DATABASE_URL
  exec node packages/engine/src/runtime/node.ts
}
demo_site() {
  cd examples/demo-site || return
  unset DATABASE_URL RUNTIME_DATABASE_URL
  HOST=127.0.0.1 PORT=4321 IDX_ENGINE_URL=http://127.0.0.1:8787 \
    IDX_SECRET_KEY="$(cat "$IDX_DEMO_DIR/site.secret")" exec node start.mjs
}
declare -f demo_engine demo_site demo_db_start demo_db_stop > "$IDX_DEMO_DIR/commands.sh"
```

Run this check with the server ports still free. It starts both servers, opens
the guide, follows search to a property, then opens that property directly. It
sends an inquiry in Chromium with JavaScript disabled. The check restarts
the engine and database, reloads the same receipt, and submits the same form
again. It verifies the same receipt and one stored inquiry. It then opens a new
form, stops the database before submitting, checks the failure and retained
values, restarts the database, and retries. The retry stores one new inquiry.
The check stops both servers when it finishes.

```bash ci
BASH_ENV="$IDX_DEMO_DIR/commands.sh" npm run test:demo -- setup.spec.ts
node scripts/check-logs.mjs
```

To explore the pages yourself after the check, start the engine and wait for
`Engine ready`. Then start the site.

```bash
demo_engine &
engine_pid=$!
```

```bash
demo_site &
site_pid=$!
```

Disable JavaScript in your browser and open <http://127.0.0.1:4321/>. Follow
**Search Example Springs**, open a property, and send an inquiry with an
invented name, email address and message. The resulting page shows the
receipt. Keep the receipt URL to revisit it after a restart.

When finished, stop the servers and exit the Bash session. The exit trap stops
the database and removes its temporary directory.

```bash
kill "$site_pid" "$engine_pid"
wait "$site_pid" "$engine_pid"
exit
```
