import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { captureLog, registerSecret } from "../logs.ts";

// All credentials are generated synthetic test values, never external secrets.
test("online preparation, restricted login, repeat build and key rotation", async (t) => {
  const owner = process.env.DATABASE_URL!.replace(/\/idx_demo$/, "/idx_online");
  const password = randomBytes(32).toString("base64url") + "'\\%";
  const secret = () => "idx_secret_" + randomBytes(32).toString("base64url");
  const env = {
    ...process.env,
    MIGRATION_DATABASE_URL: owner,
    RUNTIME_DATABASE_PASSWORD: password,
    IDX_SECRET_KEY: secret(),
  };
  for (const value of [owner, password, env.IDX_SECRET_KEY]) registerSecret(value);
  const command = (name: string, extra: string[] = [], variables = env, success = true) => {
    const result = spawnSync("npm", ["run", "--silent", name, ...extra], {
      env: variables,
      encoding: "utf8",
    });
    const log = result.stdout + result.stderr;
    captureLog("demo-prepare", log);
    for (const value of [owner, password, env.IDX_SECRET_KEY])
      assert.ok(!log.includes(value), "Command output must not contain credentials");
    assert.equal(result.status, success ? 0 : 1, "Expected command exit status");
    return log;
  };
  for (const name of ["MIGRATION_DATABASE_URL", "RUNTIME_DATABASE_PASSWORD", "IDX_SECRET_KEY"]) {
    const missing = { ...env, [name]: "" };
    assert.ok(command("demo:prepare", [], missing, false).includes(name));
  }
  const db = new pg.Client({ connectionString: owner });
  await db.connect();
  t.after(() => db.end());
  assert.equal((await db.query("SELECT 1 FROM pg_roles WHERE rolname='idx_runtime'")).rowCount, 0);
  command("demo:prepare");
  const snapshot = async () => {
    const tables = ["schema_migrations", "idx.feeds", "idx.sites", "idx.data_licenses", "idx.listings", "idx.source_mappings", "idx.site_secret_keys"];
    return Promise.all(tables.map(async (table) =>
      (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
  };
  const first = await snapshot();
  const keyVersion = async () => (await db.query("SELECT xmin::text FROM idx.site_secret_keys")).rows;
  const version = await keyVersion();
  command("demo:prepare");
  command("demo:key", ["--", "sync-demo"]);
  assert.deepEqual(await snapshot(), first);
  assert.deepEqual(await keyVersion(), version);
  const login = new URL(owner);
  login.username = "idx_runtime";
  login.password = encodeURIComponent(password);
  const runtime = new pg.Client({ connectionString: login.href });
  await runtime.connect();
  t.after(() => runtime.end());
  assert.equal((await runtime.query("SELECT current_user AS name")).rows[0].name, "idx_runtime");
  assert.equal((await runtime.query("SELECT * FROM idx.listings")).rowCount, 24);
  const role = (await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,rolreplication,rolcanlogin FROM pg_roles WHERE rolname='idx_runtime'")).rows[0];
  assert.deepEqual(Object.values(role), [false, false, false, false, false, false, true]);
  assert.equal((await db.query("SELECT 1 FROM pg_auth_members WHERE member='idx_runtime'::regrole")).rowCount, 0);
  for (const sql of ["CREATE TABLE idx.forbidden (id int)", "CREATE TABLE public.forbidden (id int)", "ALTER TABLE idx.listings ADD COLUMN forbidden int", "UPDATE idx.listings SET price=1", "DROP TABLE idx.listings"])
    await assert.rejects(runtime.query(sql), { code: "42501" });
  // The cluster uses password auth for this database and login, not trust.
  await assert.rejects(new pg.Client({ connectionString: owner.replace("idx_migration", "idx_runtime"), password: "wrong" }).connect(), { code: "28P01" });
  const oldKey = env.IDX_SECRET_KEY;
  env.IDX_SECRET_KEY = secret();
  registerSecret(env.IDX_SECRET_KEY);
  command("demo:key", ["--", "sync-demo"]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM idx.site_secret_keys WHERE site_id='site_demo_primary' AND revoked_at IS NULL")).rows[0].n, 1);
  command("demo:check");
  assert.ok(command("demo:check", [], { ...env, IDX_SECRET_KEY: oldKey }, false).includes("demo:check"));
  await db.query("DELETE FROM idx.source_mappings");
  await db.query("DELETE FROM idx.listings");
  assert.ok(command("demo:check", [], env, false).includes("seeded synthetic listings"));
  command("demo:prepare");
});
