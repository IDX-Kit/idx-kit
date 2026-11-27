import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { normalize } from "@idx-kit/engine/src/domain/normalize.ts";
import { migrate } from "@idx-kit/engine/src/db/migrate.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";

test("fresh PostgreSQL database and transactional fixture loading", async (t) => {
  assert.ok(
    process.env.DATABASE_URL,
    "A disposable migration database is required",
  );
  assert.ok(
    process.env.RUNTIME_DATABASE_URL,
    "A restricted runtime connection is required",
  );
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const runtime = new pg.Client({
    connectionString: process.env.RUNTIME_DATABASE_URL,
  });
  await db.connect();
  await runtime.connect();
  t.after(async () => {
    await runtime.end();
    await db.end();
  });
  await t.test("both test connections use PostgreSQL 18", async () => {
    for (const client of [db, runtime]) {
      const version = (await client.query("SHOW server_version")).rows[0]
        .server_version;
      const versionNum = Number(
        (await client.query("SHOW server_version_num")).rows[0]
          .server_version_num,
      );
      t.diagnostic(`Connected PostgreSQL ${version} (${versionNum})`);
      assert.match(version, /^18\./);
      assert.ok(versionNum >= 180000 && versionNum <= 189999);
    }
  });
  const fixtures = await new FixtureConnector().read();
  const reset = () =>
    db.query("TRUNCATE idx.feeds, idx.sites, idx.listings CASCADE");
  const snapshot = async () =>
    (await db.query("SELECT * FROM idx.listings ORDER BY id")).rows;

  await t.test("migrations build from empty and can run twice", async () => {
    assert.equal(
      (await db.query("SELECT to_regnamespace('idx') AS schema")).rows[0]
        .schema,
      null,
    );
    await migrate(db);
    await migrate(db);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM public.schema_migrations",
        )
      ).rows[0].count,
      11,
    );
    const owners = await db.query(
      "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'idx'",
    );
    assert.deepEqual(owners.rows, [{ tableowner: "idx_migration" }]);
    assert.equal(
      (await db.query("SELECT count(*)::int AS count FROM idx.listings"))
        .rows[0].count,
      0,
    );
  });
  await t.test(
    "migrations backfill revisions and freshness and remove legacy hidden facts",
    async () => {
      const older = "2026-11-01T00:03:00.000Z";
      await seed(db, fixtures);
      await db.query(`
        INSERT INTO idx.listings
        SELECT (jsonb_populate_record(NULL::idx.listings,
          to_jsonb(l) || '{"id":"lst_demo_0006","entire_listing_display":false}')).*
        FROM idx.listings l WHERE id = 'lst_demo_0001';
        ALTER TABLE idx.source_mappings
          DROP COLUMN source_revision,
          ADD CONSTRAINT source_mappings_listing_id_fkey FOREIGN KEY (listing_id)
            REFERENCES idx.listings;
      `);
      await db.query(
        "ALTER TABLE idx.feeds DROP COLUMN oldest_listing_ingested_at",
      );
      await db.query(
        "DELETE FROM public.schema_migrations WHERE name = ANY($1)",
        [
          [
            "004_feed_freshness.sql",
            "006_listing_revisions.sql",
            "007_feed_sync_positions.sql",
            "011_feed_sync_record_presence.sql",
          ],
        ],
      );
      await db.query("UPDATE idx.listings SET ingested_at = $1 WHERE id = $2", [
        older,
        "lst_demo_0007",
      ]);
      const listings = (await snapshot()).filter(
        (row) => row.entire_listing_display,
      );
      await db.query("DROP TABLE idx.feed_sync_positions");
      await db.query("DROP FUNCTION idx.renew_feed_freshness(text)");
      await migrate(db);
      const positions = await db.query("SELECT * FROM idx.feed_sync_positions");
      assert.deepEqual(positions.rows, []);
      const feeds = await db.query(
        "SELECT id, oldest_listing_ingested_at FROM idx.feeds ORDER BY id",
      );
      assert.deepEqual(feeds.rows, [
        {
          id: "feed_demo_expired",
          oldest_listing_ingested_at: new Date(
            fixtures.listings.at(-1)!.ingestedAt,
          ),
        },
        {
          id: "feed_demo_primary",
          oldest_listing_ingested_at: new Date(older),
        },
      ]);
      assert.deepEqual(await snapshot(), listings);
      const mapping = await db.query(
        "SELECT * FROM idx.source_mappings WHERE listing_id = $1",
        ["lst_demo_0006"],
      );
      assert.deepEqual(mapping.rows, [
        {
          feed_id: "feed_demo_primary",
          source_key: fixtures.listings[5].source.ListingKey,
          listing_id: "lst_demo_0006",
          source_revision: new Date(fixtures.listings[0].sourceUpdatedAt!),
        },
      ]);
    },
  );
  await t.test(
    "the outcome migration preserves an existing sync position",
    async () => {
      await db.query("DROP TABLE idx.feed_sync_outcomes");
      await db.query("DELETE FROM public.schema_migrations WHERE name = $1", [
        "008_feed_sync_outcomes.sql",
      ]);
      const legacy = await db.query(
        `INSERT INTO idx.feed_sync_positions
        (feed_id, version, completed_mark, next_link, pending_mark)
      VALUES ($1, 4, '2026-11-03T00:00:00Z', '?cursor=next', '2026-11-04T00:00:00Z')
      RETURNING *`,
        [fixtures.feeds[0].id],
      );
      await migrate(db);
      const upgraded = await db.query("SELECT * FROM idx.feed_sync_positions");
      assert.deepEqual(upgraded.rows, legacy.rows);
    },
  );
  await t.test(
    "the record state migration restarts sync at the completed mark",
    async () => {
      await db.query(
        "ALTER TABLE idx.feed_sync_positions DROP COLUMN record_state",
      );
      await db.query("DELETE FROM public.schema_migrations WHERE name = $1", [
        "011_feed_sync_record_presence.sql",
      ]);
      await migrate(db);
      const { rows } = await db.query(
        `SELECT version::int, completed_mark, next_link, pending_mark, record_state
        FROM idx.feed_sync_positions WHERE feed_id = $1`,
        [fixtures.feeds[0].id],
      );
      assert.deepEqual(rows, [
        {
          version: 5,
          completed_mark: new Date("2026-11-03T00:00:00Z"),
          next_link: null,
          pending_mark: null,
          record_state: "empty",
        },
      ]);
    },
  );
  await t.test(
    "the scan migration preserves listings, mappings, positions and outcomes",
    async () => {
      await db.query(
        "DROP TABLE idx.feed_scan_positions, idx.listing_scan_stamps",
      );
      await db.query("DELETE FROM public.schema_migrations WHERE name = $1", [
        "009_feed_scan.sql",
      ]);
      await db.query(
        `INSERT INTO idx.feed_sync_outcomes
          (feed_id, position_version, code, http_status, next_step, retry_after_seconds, saved_at)
        SELECT feed_id, version, 'http_error', 503, 'retry', 60, statement_timestamp()
        FROM idx.feed_sync_positions`,
      );
      const stored = async () => {
        const listings = await snapshot();
        const mappings = await db.query(
          "SELECT * FROM idx.source_mappings ORDER BY feed_id, source_key",
        );
        const positions = await db.query(
          "SELECT * FROM idx.feed_sync_positions ORDER BY feed_id",
        );
        const outcomes = await db.query(
          "SELECT * FROM idx.feed_sync_outcomes ORDER BY feed_id",
        );
        return [listings, mappings.rows, positions.rows, outcomes.rows];
      };
      const before = await stored();
      assert.ok(before.every((rows) => rows.length > 0));
      await migrate(db);
      assert.deepEqual(await stored(), before);
      assert.equal(
        (await db.query("SELECT * FROM idx.feed_scan_positions")).rowCount,
        0,
      );
      assert.equal(
        (await db.query("SELECT * FROM idx.listing_scan_stamps")).rowCount,
        0,
      );
    },
  );
  await t.test(
    "runtime reads listings but cannot change schema, sites or accepted inquiries",
    async () => {
      await runtime.query("SELECT * FROM idx.listings");
      for (const sql of [
        "CREATE TABLE idx.forbidden (id int)",
        "CREATE TABLE public.forbidden (id int)",
        "DROP TABLE idx.listings",
        "DELETE FROM idx.listings",
        "UPDATE idx.listings SET address=NULL",
        "INSERT INTO idx.source_mappings (feed_id, source_key, listing_id) SELECT 'a', 'b', 'c'",
        "UPDATE idx.source_mappings SET source_revision=now()",
        "UPDATE idx.feeds SET oldest_listing_ingested_at=now()",
        "UPDATE idx.feeds SET display_blocks='[]'",
        "UPDATE idx.feeds SET refreshed_at=now()",
        "SELECT * FROM idx.feed_sync_positions",
        "INSERT INTO idx.feed_sync_positions (feed_id, version) VALUES ('feed_demo_primary', 1)",
        "UPDATE idx.feed_sync_positions SET version=2",
        "DELETE FROM idx.feed_sync_positions",
        "SELECT * FROM idx.feed_sync_outcomes",
        "INSERT INTO idx.feed_sync_outcomes (feed_id, position_version, code, saved_at) VALUES ('feed_demo_primary', 0, 'complete', now())",
        "UPDATE idx.feed_sync_outcomes SET code='complete'",
        "DELETE FROM idx.feed_sync_outcomes",
        "SELECT * FROM idx.feed_scan_positions",
        "INSERT INTO idx.feed_scan_positions VALUES ('feed_demo_primary', 1, 1, true, NULL)",
        "UPDATE idx.feed_scan_positions SET active=false",
        "DELETE FROM idx.feed_scan_positions",
        "SELECT * FROM idx.listing_scan_stamps",
        "INSERT INTO idx.listing_scan_stamps VALUES ('lst_demo_0001', 1)",
        "UPDATE idx.listing_scan_stamps SET scan_number=2",
        "DELETE FROM idx.listing_scan_stamps",
        "SELECT idx.renew_feed_freshness('feed_demo_primary')",
        "INSERT INTO idx.sites VALUES ('forbidden')",
        "UPDATE idx.site_secret_keys SET listing_request_limit=1000",
        "DELETE FROM idx.listing_request_windows",
        "UPDATE idx.inquiries SET message='forbidden'",
        "DELETE FROM idx.inquiries",
        "TRUNCATE idx.inquiries",
      ]) {
        await assert.rejects(runtime.query(sql), { code: "42501" });
      }
    },
  );
  await t.test(
    "feed writers serialize before a new feed commits and permit cross-feed licenses",
    async (t) => {
      await reset();
      await seed(db, fixtures);
      const peer = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      await peer.connect();
      t.after(() => peer.end());
      const [feed, otherFeed] = fixtures.feeds;
      const newFeed = { ...feed, id: "feed_seed_new" };
      const [first, later] = structuredClone(fixtures.listings);
      first.feedId = newFeed.id;
      first.publicId = "lst_seed_first";
      later.feedId = newFeed.id;
      later.publicId = "lst_seed_later";
      later.ingestedAt = "2026-11-01T01:00:00Z";
      const partial = { feeds: [], sites: [], listings: [later] };
      const query = db.query.bind(db);
      const peerQuery = peer.query.bind(peer);
      const blocked = new Error("The first seed still holds the feed lock");
      const tryLock = async (sql: string, values?: unknown[]) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return peerQuery(sql);
        assert.match(sql, /pg_advisory_xact_lock/);
        // Probe the same lock without waiting for the writer paused at COMMIT.
        const probe = sql.replace("pg_advisory", "pg_try_advisory");
        const attempt = await peerQuery(probe, values);
        assert.equal(attempt.rows[0].pg_try_advisory_xact_lock, false);
        throw blocked;
      };
      const beforeCommit = async (sql: string, values?: unknown[]) => {
        if (sql === "COMMIT") {
          const visible = await peer.query(
            "SELECT id FROM idx.feeds WHERE id = $1",
            [newFeed.id],
          );
          assert.equal(visible.rowCount, 0);
          const contender = t.mock.method(peer, "query", tryLock);
          await assert.rejects(seed(peer, partial), blocked);
          contender.mock.restore();
          await peer.query(
            "SELECT id FROM idx.feeds WHERE id = $1 FOR KEY SHARE NOWAIT",
            [feed.id],
          );
          await seed(peer, {
            feeds: [otherFeed],
            sites: [{ id: "site_demo_other", feedIds: [feed.id] }],
            listings: [],
          });
        }
        return query(sql, values);
      };
      const writer = t.mock.method(db, "query", beforeCommit);
      await seed(db, {
        feeds: [feed, newFeed],
        sites: [{ id: "site_demo_primary", feedIds: [otherFeed.id] }],
        listings: [first],
      });
      writer.mock.restore();
      await seed(peer, partial);
      const freshness = await db.query(
        "SELECT oldest_listing_ingested_at FROM idx.feeds WHERE id = $1",
        [newFeed.id],
      );
      assert.deepEqual(freshness.rows, [
        { oldest_listing_ingested_at: new Date(first.ingestedAt) },
      ]);
    },
  );
  await t.test(
    "all 24 fixture identities seed, reseed identically and update without changing public IDs",
    async () => {
      await reset();
      assert.equal(fixtures.listings.length, 24);
      await seed(db, fixtures);
      const original = await snapshot();
      assert.equal(original.length, 23);
      assert.deepEqual(
        original.map((row) => row.id),
        fixtures.listings
          .filter((record) => record.source.InternetEntireListingDisplayYN)
          .map((record) => record.publicId)
          .sort(),
      );
      await seed(db, fixtures);
      assert.deepEqual(await snapshot(), original);
      const changed = structuredClone(fixtures);
      changed.listings[0].source.ListPrice = "123456.789";
      changed.listings[0].publicId = "lst_candidate_changed";
      await seed(db, changed);
      const updated = await snapshot();
      assert.equal(updated.length, 23);
      assert.deepEqual(
        updated.map((row) => row.id),
        original.map((row) => row.id),
      );
      assert.equal(updated[0].price, "123456.789");
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM idx.source_mappings",
          )
        ).rows[0].count,
        24,
      );
    },
  );
  await t.test(
    "every missing required source fact rolls back the entire seed",
    async () => {
      for (const fact of [
        "ListingKey",
        "StandardStatus",
        "ListPrice",
        "BedroomsTotal",
        "Address",
        "Images",
        "InternetAddressDisplayYN",
        "InternetEntireListingDisplayYN",
      ]) {
        await reset();
        const invalid = structuredClone(fixtures);
        Reflect.deleteProperty(invalid.listings.at(-1)!.source, fact);
        await assert.rejects(seed(db, invalid), /Missing required source fact/);
        for (const table of [
          "feeds",
          "sites",
          "data_licenses",
          "listings",
          "source_mappings",
        ]) {
          assert.equal(
            (await db.query(`SELECT count(*)::int AS count FROM idx.${table}`))
              .rows[0].count,
            0,
          );
        }
      }
    },
  );
  await t.test(
    "a failed reseed also restores previously committed values",
    async () => {
      await seed(db, fixtures);
      const original = await snapshot();
      const invalid = structuredClone(fixtures);
      invalid.listings[0].source.ListPrice = "1.00";
      Reflect.deleteProperty(invalid.listings.at(-1)!.source, "ListPrice");
      await assert.rejects(seed(db, invalid), /Missing required source fact/);
      assert.deepEqual(await snapshot(), original);
    },
  );
  await t.test(
    "explicit null is preserved for every nullable fact",
    async () => {
      await reset();
      const nullable = structuredClone(fixtures);
      Object.assign(nullable.listings[0].source, {
        StandardStatus: null,
        ListPrice: null,
        BedroomsTotal: null,
        Address: null,
        Images: null,
      });
      await seed(db, nullable);
      const row = (await snapshot())[0];
      for (const fact of [
        "status",
        "price",
        "currency",
        "bedrooms",
        "address",
        "images",
      ])
        assert.equal(row[fact], null);
      assert.deepEqual(row.withheld_fields, []);
    },
  );
  await t.test(
    "exact source keys stay separate and are scoped by feed",
    async () => {
      await reset();
      const scoped = structuredClone(fixtures);
      scoped.listings[23].source.ListingKey =
        scoped.listings[0].source.ListingKey;
      scoped.listings[1].source.ListingKey =
        scoped.listings[0].source.ListingKey.trim();
      scoped.listings[2].source.ListingKey =
        scoped.listings[0].source.ListingKey.toLowerCase();
      await seed(db, scoped);
      const mappings = (await db.query("SELECT * FROM idx.source_mappings"))
        .rows;
      for (const record of scoped.listings)
        assert.ok(
          mappings.some(
            (row) =>
              row.feed_id === record.feedId &&
              row.source_key === record.source.ListingKey &&
              row.listing_id === record.publicId,
          ),
        );
      const columns = (
        await db.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'idx' AND table_name = 'listings'",
        )
      ).rows;
      assert.ok(
        !columns.some((row) =>
          ["source_key", "ListingKey", "ListPrice"].includes(row.column_name),
        ),
      );
      assert.ok(
        !Object.hasOwn(normalize(scoped.listings[0]).facts, "ListingKey"),
      );
    },
  );
  await t.test(
    "withholding, withdrawal, closed disclosures and isolated expired feed are data",
    async () => {
      await reset();
      await seed(db, fixtures);
      const rows = await snapshot();
      assert.equal(rows[1].address, null);
      assert.deepEqual(rows[1].withheld_fields, ["address"]);
      assert.ok(
        !JSON.stringify(rows[1]).includes(
          fixtures.listings[1].source.Address!.line1,
        ),
      );
      assert.equal(rows[2].status, "closed");
      assert.equal(rows[2].page_blocks[0].id, "closed_information");
      assert.ok(!rows.some((row) => row.id === "lst_demo_0006"));
      assert.equal(rows[3].price, null);
      assert.equal(rows[0].price, rows[2].price);
      assert.ok(
        rows.every(
          (row) =>
            row.synthetic && row.display_blocks[0].id === "synthetic_broker",
        ),
      );
      assert.deepEqual(
        (await db.query("SELECT * FROM idx.data_licenses ORDER BY site_id"))
          .rows,
        [
          { site_id: "site_demo_other", feed_id: "feed_demo_expired" },
          { site_id: "site_demo_primary", feed_id: "feed_demo_primary" },
        ],
      );
      assert.deepEqual(
        (await db.query("SELECT id FROM idx.feeds WHERE expires_at < now()"))
          .rows,
        [{ id: "feed_demo_expired" }],
      );
    },
  );
  await t.test(
    "Site key storage accepts only scoped hashes and retains revocation",
    async () => {
      const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
      await db.query(
        "INSERT INTO idx.site_secret_keys VALUES ('key_test', 'site_demo_primary', $1, ARRAY['listings:read'], NULL)",
        [hash],
      );
      await db.query(
        "UPDATE idx.site_secret_keys SET revoked_at = now() WHERE id = 'key_test'",
      );
      const row = (
        await runtime.query(
          "SELECT * FROM idx.site_secret_keys WHERE id = 'key_test'",
        )
      ).rows[0];
      assert.equal(row.secret_hash, hash);
      assert.ok(row.revoked_at);
      await assert.rejects(
        db.query(
          "INSERT INTO idx.site_secret_keys VALUES ('key_bad', 'site_demo_primary', 'unhashed', ARRAY['listings:read'], NULL)",
        ),
        { code: "23514" },
      );
      await assert.rejects(
        db.query(
          "INSERT INTO idx.site_secret_keys VALUES ('key_bad', 'site_demo_primary', $1, ARRAY['admin'], NULL)",
          [hash],
        ),
        { code: "23514" },
      );
    },
  );
});
