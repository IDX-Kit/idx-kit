import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { FixtureConnector } from "../connectors/fixture.ts";
import { migrate } from "../db/migrate.ts";
import { seed } from "../db/seed.ts";
import { repository } from "../db/read.ts";
import { hashSecret } from "../domain/keys.ts";
import { createApp } from "../http/app.ts";
import { failureFields, logLine } from "../log.ts";

const site = "site_demo_primary";
class DemoError extends Error {}
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new DemoError(`Missing ${name}.`);
  return value;
}

export async function demoKey(db: pg.Client, secret: string) {
  const hash = await hashSecret(secret);
  await db.query("BEGIN");
  try {
    await db.query("SELECT id FROM idx.sites WHERE id=$1 FOR UPDATE", [site]);
    await db.query(
      `UPDATE idx.site_secret_keys SET revoked_at=now()
       WHERE site_id=$1 AND revoked_at IS NULL AND secret_hash<>$2`,
      [site, hash],
    );
    await db.query(
      `INSERT INTO idx.site_secret_keys (id,site_id,secret_hash,scopes)
       VALUES ($1,$2,$3,ARRAY['listings:read'])
       ON CONFLICT (secret_hash) DO UPDATE SET scopes=EXCLUDED.scopes, revoked_at=NULL
       WHERE idx.site_secret_keys.site_id=EXCLUDED.site_id AND
         (idx.site_secret_keys.revoked_at IS NOT NULL OR idx.site_secret_keys.scopes<>EXCLUDED.scopes)`,
      ["key_" + randomUUID(), site, hash],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function checkListings(connectionString: string, secret: string) {
  const runtime = new pg.Client({ connectionString });
  try {
    await runtime.connect();
    const app = createApp(repository(runtime), {}, "demo-build");
    const response = await app.request("https://engine.internal/api/v1/listings?limit=50", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await response.json();
    const expected = (await new FixtureConnector().read()).listings.filter(
      (record) => record.feedId === "feed_demo_primary" && record.source.InternetEntireListingDisplayYN,
    );
    if (response.status !== 200 || body.data.length !== expected.length ||
      !expected.every((record) => body.data.some((listing: { id: string; synthetic: boolean }) =>
        listing.id === record.publicId && listing.synthetic))) {
      throw new DemoError("demo:check failed: seeded synthetic listings are missing or unavailable.");
    }
  } finally {
    await runtime.end();
  }
}

export async function runDemo(action: string) {
  let stage = "configuration";
  try {
    const owner = required("MIGRATION_DATABASE_URL");
    const secret = required("IDX_SECRET_KEY");
    if (!/^idx_secret_[A-Za-z0-9_-]{43}$/.test(secret))
      throw new DemoError("IDX_SECRET_KEY must use idx_secret_ plus base64url of 32 random bytes.");
    const runtime = new URL(owner);
    runtime.username = "idx_runtime";
    runtime.password = encodeURIComponent(required("RUNTIME_DATABASE_PASSWORD"));
    if (action === "check") {
      stage = "demo:check";
      await checkListings(runtime.href, secret);
      return;
    }
    const db = new pg.Client({ connectionString: owner });
    try {
      stage = "database connection";
      await db.connect();
      if (action === "prepare") {
        const password = required("RUNTIME_DATABASE_PASSWORD");
        if (password.length < 32)
          throw new DemoError("RUNTIME_DATABASE_PASSWORD must have at least 32 characters.");
        stage = "runtime role";
        if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname='idx_runtime'")).rowCount)
          await db.query("CREATE ROLE idx_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION");
        if ((await db.query("SELECT 1 FROM pg_auth_members WHERE member='idx_runtime'::regrole")).rowCount)
          throw new DemoError("idx_runtime must not be granted another role.");
        const role = (await db.query("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls OR rolreplication AS unsafe FROM pg_roles WHERE rolname='idx_runtime'")).rows[0];
        if (role.unsafe)
          throw new DemoError("idx_runtime must have no elevated privileges and NOINHERIT.");
        await db.query(`ALTER ROLE idx_runtime LOGIN PASSWORD ${pg.escapeLiteral(password)}`);
        stage = "migrations";
        await migrate(db);
        stage = "fixture seed";
        await seed(db, await new FixtureConnector().read());
      }
      stage = "demo:key";
      await demoKey(db, secret);
    } finally {
      await db.end();
    }
    if (action === "prepare") {
      stage = "demo:check";
      await checkListings(runtime.href, secret);
    }
    console.log("Demo preparation passed.");
  } catch (error) {
    console.error(logLine({
      operation: stage,
      ...failureFields(error),
      message: error instanceof DemoError ? error.message : `Demo ${stage} failed; check the database connection and permissions.`,
    }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runDemo(process.argv[2] ?? "prepare");
