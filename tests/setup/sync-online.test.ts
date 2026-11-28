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
import { migrate } from "@idx-kit/engine/src/db/migrate.ts";
import { parseFeedSettings } from "@idx-kit/engine/src/runtime/sync-feed-settings.ts";
import { prepareDatabase } from "@idx-kit/engine/src/runtime/sync-prepare.ts";
import { feedToken, page, standIn } from "../sync/feed.ts";

test("shared setup and hosted builds preserve feed state and logins", async (t) => {
  const owner = process.env.DATABASE_URL!;
  const password = randomBytes(32).toString("base64url");
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
    IDX_SYNC_FRESHNESS_SECONDS: "2700",
    IDX_SYNC_FEED_JSON: JSON.stringify(settings),
    IDX_SYNC_FEED_TOKEN: feedToken,
  };
  function prepare(overrides: NodeJS.ProcessEnv = {}, status = 0) {
    const result = spawnSync("npm", ["run", "--silent", "sync:prepare"], {
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    const log = result.stdout + result.stderr;
    for (const secret of [owner, password, feedToken])
      assert.ok(!log.includes(secret), "Preparation exposed a credential");
    assert.equal(result.status, status, log);
    return log;
  }
  assert.match(
    prepare({ IDX_SYNC_FRESHNESS_SECONDS: "" }, 1),
    /IDX_SYNC_FRESHNESS_SECONDS/,
  );
  assert.match(
    prepare({ IDX_SYNC_FEED_JSON: `{"token":"${feedToken}"}` }, 1),
    /IDX_SYNC_FEED_JSON/,
  );
  const badConnection = new URL(owner);
  badConnection.port = "1";
  const failed = prepare({ MIGRATION_DATABASE_URL: badConnection.href }, 1);
  assert.match(failed, /Check the database connection and permissions/);
  assert.ok(!failed.includes(badConnection.href));
  const db = new pg.Client({ connectionString: owner });
  await db.connect();
  t.after(() => db.end());
  const roles = () =>
    db.query(`
      SELECT rolname, rolcanlogin, rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit
        OR rolbypassrls OR rolreplication AS unsafe,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS member
      FROM pg_roles WHERE rolname IN ('idx_runtime', 'idx_listing_writer') ORDER BY rolname
    `);
  assert.deepEqual((await roles()).rows, []);
  const query = t.mock.method(db, "query");
  await prepareDatabase(db, parseFeedSettings(settings), 2700);
  for (const call of query.mock.calls)
    assert.doesNotMatch(
      JSON.stringify(call.arguments),
      /password|postgres(?:ql)?:\/\//i,
    );
  query.mock.restore();
  assert.deepEqual((await roles()).rows, [
    {
      rolname: "idx_listing_writer",
      rolcanlogin: true,
      unsafe: false,
      member: false,
    },
    { rolname: "idx_runtime", rolcanlogin: true, unsafe: false, member: false },
  ]);
  const feeds = () => db.query("SELECT xmin::text, * FROM idx.feeds");
  const original = (await feeds()).rows;
  assert.equal(original.length, 1);
  assert.equal(original[0].id, settings.feedId);
  assert.equal(original[0].freshness_seconds, 2700);
  assert.equal(original[0].rules_version, "1");
  assert.equal(original[0].expires_at.toISOString(), "1900-01-01T00:00:00.000Z");
  assert.deepEqual(
    original[0].display_blocks,
    settings.disclosures.approvedFeedBlocks,
  );

  await db.query(`
    ALTER ROLE idx_runtime NOLOGIN;
    ALTER ROLE idx_listing_writer NOLOGIN;
  `);
  prepare();
  assert.deepEqual(
    (await roles()).rows.map(({ rolcanlogin }) => rolcanlogin),
    [false, false],
  );
  assert.deepEqual((await feeds()).rows, original);
  await db.query(`
    ALTER ROLE idx_runtime LOGIN;
    ALTER ROLE idx_listing_writer LOGIN;
  `);

  const urls = new Map<string, string>();
  for (const name of ["idx_runtime", "idx_listing_writer"]) {
    const result = spawnSync(
      "psql",
      ["-X", owner, "-v", "ON_ERROR_STOP=1", "-c", `\\password ${name}`],
      { input: `${password}\n${password}\n` },
    );
    assert.equal(result.status, 0, "psql could not set the login password");
    const url = new URL(owner);
    url.username = name;
    url.password = password;
    urls.set(name, url.href);
  }
  const directory = await mkdtemp(join(tmpdir(), "idx-sync-online-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "feed.json");
  await writeFile(file, env.IDX_SYNC_FEED_JSON);
  async function sync() {
    const { stdout } = await promisify(execFile)(
      "npm",
      ["run", "--silent", "sync", "--", "incremental"],
      {
        env: {
          ...env,
          LISTING_WRITER_DATABASE_URL: urls.get("idx_listing_writer"),
          IDX_SYNC_FEED_FILE: file,
        },
      },
    );
    assert.equal(JSON.parse(stdout).code, "complete");
  }
  await sync();
  assert.deepEqual(
    feed.calls.map(({ authorized }) => authorized),
    [true],
  );
  const snapshot = async () => {
    const { rows } = await db.query(`
      SELECT to_jsonb(f) - 'freshness_seconds' AS feed, to_jsonb(p) AS position,
        (SELECT jsonb_agg(l ORDER BY l.id) FROM idx.listings l) AS listings
      FROM idx.feeds f JOIN idx.feed_sync_positions p ON p.feed_id=f.id
    `);
    return rows;
  };
  const loaded = await snapshot();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].listings.length, 1);
  assert.equal(
    Date.parse(loaded[0].position.completed_mark),
    Date.parse(revision),
  );
  assert.ok(loaded[0].feed.applied_disclosures);
  const active = (await feeds()).rows[0];
  assert.ok(active.expires_at.getTime() > Date.now());
  assert.equal(active.expires_at - active.refreshed_at, 2_700_000);

  // Recreate the pre-017 feed state with a window that includes microseconds.
  await db.query(`
    ALTER TABLE idx.feeds DROP COLUMN freshness_seconds;
    DELETE FROM public.schema_migrations WHERE name = '017_feed_freshness_window.sql';
    UPDATE idx.feeds SET expires_at = refreshed_at + interval '2700.125001 seconds';
  `);
  await migrate(db);
  assert.equal((await feeds()).rows[0].freshness_seconds, null);
  await sync();
  const legacy = await db.query(`
    SELECT refreshed_at, expires_at - refreshed_at = interval '2700.125001 seconds' AS exact
    FROM idx.feeds
  `);
  assert.ok(legacy.rows[0].refreshed_at > active.refreshed_at);
  assert.equal(legacy.rows[0].exact, true);

  const first = await snapshot();
  settings.disclosures.approvedFeedBlocks[0].text = "Invented unapplied notice";
  await db.query("REVOKE SELECT ON idx.listings FROM idx_listing_writer");
  prepare({
    IDX_SYNC_FRESHNESS_SECONDS: "1800",
    IDX_SYNC_FEED_JSON: JSON.stringify(settings),
  });
  assert.equal((await feeds()).rows[0].freshness_seconds, 1800);
  assert.deepEqual(await snapshot(), first);

  // A successful renewal uses the new window.
  await sync();
  const renewed = (await feeds()).rows[0];
  assert.equal(renewed.expires_at - renewed.refreshed_at, 1_800_000);

  for (const name of urls.keys()) {
    const login = new pg.Client({ connectionString: urls.get(name) });
    await login.connect();
    t.after(() => login.end());
    assert.equal((await login.query("SELECT * FROM idx.listings")).rowCount, 1);
    if (name === "idx_listing_writer")
      await assert.rejects(login.query("SELECT * FROM idx.site_secret_keys"), {
        code: "42501",
      });
  }
});
