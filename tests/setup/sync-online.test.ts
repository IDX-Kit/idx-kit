import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { parse } from "yaml";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { feedToken, page, standIn } from "../sync/feed.ts";

test("hosted preparation, writer password and grants, and repeat builds", async (t) => {
  const owner = process.env.DATABASE_URL!;
  const password = randomBytes(32).toString("base64url") + "'\\%";
  const { listings } = await new FixtureConnector().read();
  const revision = "2026-11-03T00:00:00.000001Z";
  const feed = await standIn(t, () =>
    page([{ ...listings[0].source, ModificationTimestamp: revision }]),
  );
  const guide = await readFile(
    new URL("../../docs/feed-sync.md", import.meta.url),
    "utf8",
  );
  const example = guide.match(/```yaml\n([\s\S]+?)```/)![1];
  const settings = { ...parse(example), propertyUrl: feed.propertyUrl };
  const env = {
    ...process.env,
    MIGRATION_DATABASE_URL: owner,
    LISTING_WRITER_DATABASE_PASSWORD: password,
    IDX_SYNC_FEED_JSON: JSON.stringify(settings),
    IDX_SYNC_FEED_TOKEN: feedToken,
  };
  function prepare(overrides = {}, status = 0, privateValue = "") {
    const result = spawnSync("npm", ["run", "--silent", "sync:prepare"], {
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    const log = result.stdout + result.stderr;
    for (const secret of [owner, password, feedToken, privateValue].filter(
      Boolean,
    ))
      assert.ok(!log.includes(secret), "Preparation exposed a credential");
    assert.equal(result.status, status, log);
    return log;
  }
  const badConnection = new URL(owner);
  badConnection.port = "1";
  assert.match(
    prepare(
      { MIGRATION_DATABASE_URL: badConnection.href },
      1,
      badConnection.href,
    ),
    /"operation":"database connection"/,
  );
  const shortPassword = "short-password-marker";
  assert.match(
    prepare(
      { LISTING_WRITER_DATABASE_PASSWORD: shortPassword },
      1,
      shortPassword,
    ),
    /LISTING_WRITER_DATABASE_PASSWORD/,
  );
  assert.match(
    prepare({ IDX_SYNC_FEED_JSON: `{"token":"${feedToken}"` }, 1),
    /IDX_SYNC_FEED_JSON/,
  );

  const db = new pg.Client({ connectionString: owner });
  await db.connect();
  t.after(() => db.end());
  const runtimes = () =>
    db.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='idx_runtime'");
  assert.equal((await runtimes()).rowCount, 0);
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM pg_roles WHERE rolname='idx_listing_writer'",
      )
    ).rowCount,
    0,
  );
  const [status, location] = prepare().trim().split("\n");
  assert.equal(status, "Sync preparation passed.");
  assert.deepEqual(JSON.parse(location), {
    host: "127.0.0.1",
    port: 55432,
    database: "idx_sync_online",
  });
  assert.deepEqual((await runtimes()).rows, [{ rolcanlogin: false }]);
  const original = await db.query(
    "SELECT display_blocks, expires_at < now() AS expired FROM idx.feeds",
  );
  assert.deepEqual(original.rows, [
    { display_blocks: settings.disclosures.approvedFeedBlocks, expired: true },
  ]);

  const writer = new URL(owner);
  writer.username = "idx_listing_writer";
  writer.password = encodeURIComponent(password);
  const directory = await mkdtemp(join(tmpdir(), "idx-sync-online-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "feed.json");
  await writeFile(file, env.IDX_SYNC_FEED_JSON);
  const { stdout } = await promisify(execFile)(
    "npm",
    ["run", "--silent", "sync", "--", "incremental"],
    {
      env: {
        ...env,
        LISTING_WRITER_DATABASE_URL: writer.href,
        IDX_SYNC_FEED_FILE: file,
      },
    },
  );
  assert.equal(JSON.parse(stdout).code, "complete");
  assert.deepEqual(
    feed.calls.map(({ authorized }) => authorized),
    [true],
  );
  const snapshot = async () => {
    const { rows } = await db.query(`
      SELECT to_jsonb(f) AS feed, to_jsonb(p) AS position, f.expires_at > now() AS fresh
      FROM idx.feeds f JOIN idx.feed_sync_positions p ON p.feed_id=f.id
    `);
    return rows;
  };
  const first = await snapshot();
  assert.equal(first.length, 1);
  assert.ok(first[0].fresh);
  assert.equal(
    Date.parse(first[0].position.completed_mark),
    Date.parse(revision),
  );
  await db.query("ALTER ROLE idx_runtime LOGIN");
  prepare();
  assert.deepEqual((await runtimes()).rows, [{ rolcanlogin: true }]);
  assert.equal((await db.query("SELECT id FROM idx.feeds")).rowCount, 1);
  assert.deepEqual(await snapshot(), first);

  const roles = await db.query(`
    SELECT rolcanlogin, rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit
      OR rolbypassrls OR rolreplication AS unsafe,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS member
    FROM pg_roles WHERE rolname='idx_listing_writer'
  `);
  assert.deepEqual(roles.rows, [
    { rolcanlogin: true, unsafe: false, member: false },
  ]);
  const login = new pg.Client({ connectionString: writer.href });
  await login.connect();
  t.after(() => login.end());
  assert.equal((await login.query("SELECT * FROM idx.listings")).rowCount, 1);
  await assert.rejects(login.query("SELECT * FROM idx.site_secret_keys"), {
    code: "42501",
  });
});
