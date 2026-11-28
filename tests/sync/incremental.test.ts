import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import pg from "pg";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { ResoConnector } from "@idx-kit/engine/src/connectors/reso.ts";
import { readFeedState } from "@idx-kit/engine/src/db/feed-sync-outcomes.ts";
import type { FeedNextStep } from "@idx-kit/engine/src/db/feed-sync-outcomes.ts";
import { readFeedCheckpoint } from "@idx-kit/engine/src/db/feed-sync-positions.ts";
import { applyListingPage } from "@idx-kit/engine/src/db/listings.ts";
import { repository } from "@idx-kit/engine/src/db/read.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { hashSecret } from "@idx-kit/engine/src/domain/keys.ts";
import { createApp } from "@idx-kit/engine/src/http/app.ts";
import { syncIncrementally } from "@idx-kit/engine/src/sync/incremental.ts";
import { contract, validateResponse } from "../api/contract.ts";
import { fixtureDisclosures } from "../api/listing-page.ts";
import { listenOnLoopback } from "../api/loopback-server.ts";
import {
  connectWriter,
  countWriterStatements,
  feedToken,
  page,
  propertyPath,
  readOldestIngest,
  standIn,
} from "./feed.ts";

const assertRun = assert.partialDeepStrictEqual;
const firstMark = "2026-11-03T00:00:00.000001Z";
const secondMark = "2026-11-03T00:00:00.000002Z";
const thirdMark = "2026-11-03T00:00:00.000003Z";
const futureMark = "2099-01-01T00:00:00.000000Z";
const initialRefresh = "2000-01-01T00:00:00Z";
const initialExpiry = "2000-01-01T12:00:00Z";
const retry = { kind: "retry" } as const;
const stop = { kind: "stop" } as const;
const retryHttpError = { code: "http_error", nextStep: retry };
const stopHttpError = { code: "http_error", nextStep: stop };
const writeFailed = { code: "write_failed", nextStep: retry };
const pageLimitReached = { code: "page_limit", nextStep: retry };

const filter = (mark: string) =>
  `?${new URLSearchParams({ $filter: `ModificationTimestamp ge ${mark}` })}`;

test("incremental listing sync over HTTP", { timeout: 45_000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  t.after(() => db.end());
  const writer = await connectWriter(t);
  const fixtures = await new FixtureConnector().read();
  const [fixtureFeed] = fixtures.feeds;
  const disclosures = fixtureDisclosures(fixtures, fixtureFeed.id);
  const record = (key: string, revision: string, price = "100.00") => ({
    ...fixtures.listings[0].source,
    ListingKey: `Synthetic sync ${key}`,
    ModificationTimestamp: revision,
    ListPrice: price,
  });
  const first = record("first", firstMark);
  const second = record("second", secondMark, "200.00");
  const third = record("third", thirdMark, "300.00");
  type StandIn = Awaited<ReturnType<typeof standIn>>;

  async function setup(t: TestContext, name: string, siteId?: string) {
    const feedId = `feed_sync_${name}`;
    const setOldFreshness = () =>
      db.query(
        "UPDATE idx.feeds SET refreshed_at=$2, expires_at=$3 WHERE id=$1",
        [feedId, initialRefresh, initialExpiry],
      );
    await seed(db, {
      feeds: [
        {
          ...fixtureFeed,
          id: feedId,
          refreshedAt: initialRefresh,
          expiresAt: initialExpiry,
        },
      ],
      listings: [],
      sites: siteId ? [{ id: siteId, feedIds: [feedId] }] : [],
    });
    t.after(async () => {
      if (siteId) {
        await db.query("DELETE FROM idx.site_secret_keys WHERE site_id=$1", [
          siteId,
        ]);
        await db.query("DELETE FROM idx.data_licenses WHERE site_id=$1", [
          siteId,
        ]);
        await db.query("DELETE FROM idx.sites WHERE id=$1", [siteId]);
      }
      await db.query(
        `DELETE FROM idx.listings l USING idx.source_mappings m
        WHERE l.id=m.listing_id AND m.feed_id=$1`,
        [feedId],
      );
      await db.query("DELETE FROM idx.source_mappings WHERE feed_id=$1", [
        feedId,
      ]);
      await db.query("DELETE FROM idx.feeds WHERE id=$1", [feedId]);
    });
    const freshness = async () => {
      const { rows } = await db.query<{
        refreshed_at: Date;
        expires_at: Date;
      }>("SELECT refreshed_at, expires_at FROM idx.feeds WHERE id=$1", [
        feedId,
      ]);
      return rows[0];
    };
    const listings = async () => {
      const { rows } = await db.query<{
        key: string;
        id: string;
        price: string | null;
        revision: string;
      }>(
        `SELECT m.source_key AS key, m.listing_id AS id, l.price,
          to_char(l.source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision
        FROM idx.source_mappings m LEFT JOIN idx.listings l ON l.id=m.listing_id
        WHERE m.feed_id=$1 ORDER BY m.source_key`,
        [feedId],
      );
      return rows;
    };
    const facts = async () =>
      (await listings()).map(({ key, price, revision }) => ({
        key,
        price,
        revision,
      }));
    const outcome = async () => {
      const { rows } = await db.query(
        `SELECT code, http_status AS status, next_step AS step, position_version::int AS version,
          retry_after_seconds AS "afterSeconds", saved_at AS "savedAt"
        FROM idx.feed_sync_outcomes WHERE feed_id = $1`,
        [feedId],
      );
      return rows[0];
    };
    return {
      feedId,
      run: (
        { connector }: Pick<StandIn, "connector">,
        client = writer,
        pageLimit?: number,
      ) =>
        syncIncrementally(
          client,
          { feedId, synthetic: true, connector, disclosures },
          pageLimit,
        ),
      checkpoint: () => readFeedCheckpoint(db, feedId),
      status: async () => (await readFeedState(db, feedId, true))?.status,
      oldestIngest: () => readOldestIngest(db, feedId),
      outcome,
      setOldFreshness,
      freshness,
      listings,
      facts,
    };
  }

  async function assertOutcome(
    state: Awaited<ReturnType<typeof setup>>,
    expected: {
      code: string;
      status: number | null;
      step: "retry" | "stop" | null;
      version: number;
      afterSeconds?: number;
    },
  ) {
    const { savedAt, ...outcome } = await state.outcome();
    const { afterSeconds = null, ...fields } = expected;
    assert.ok(savedAt instanceof Date);
    assert.deepEqual(outcome, { ...fields, afterSeconds });
  }

  async function assertFresh(state: Awaited<ReturnType<typeof setup>>) {
    const { refreshed_at, expires_at } = await state.freshness();
    assert.ok(refreshed_at.getTime() > Date.parse(initialRefresh));
    assert.equal(expires_at.getTime() - refreshed_at.getTime(), 43_200_000);
  }

  const complete = (completedMark: string | null) => ({
    completedMark,
    nextLink: null,
    pendingMark: null,
    recordState: "empty",
  });

  await t.test(
    "an empty first poll applies notices and a later edit only changes that listing",
    async (t) => {
      const state = await setup(t, "idle_notices");
      const edit = {
        ...first,
        ListPrice: "225.00",
        ModificationTimestamp: thirdMark,
      };
      const feed = await standIn(t, (_url, number) => {
        if (number <= 2) return page([]);
        if (number === 3) return page([first, second]);
        return page([edit]);
      });
      const options = {
        feedId: state.feedId,
        synthetic: true,
        connector: feed.connector,
      };
      const statements = countWriterStatements(t, writer);
      const emptyRun = {
        code: "complete",
        counts: { accepted: 0, rejected: 0, rejectedByCode: {} },
      };
      assert.deepEqual(
        await syncIncrementally(writer, { ...options, disclosures }),
        emptyRun,
      );
      assert.equal(statements(), 9);
      const alternate = {
        ...disclosures,
        approvedFeedBlocks: [
          {
            ...disclosures.approvedFeedBlocks[0],
            text: "Unused synthetic notice",
          },
        ],
      };
      assert.deepEqual(
        await syncIncrementally(writer, { ...options, disclosures: alternate }),
        emptyRun,
      );
      assert.equal(statements(), 17);
      assert.deepEqual(await state.checkpoint(), {
        version: 2n,
        position: complete(null),
      });
      await assertFresh(state);
      assert.deepEqual(
        (await state.status())?.lastRun?.counts,
        emptyRun.counts,
      );
      const { rows } = await db.query(
        "SELECT applied_disclosures FROM idx.feeds WHERE id = $1",
        [state.feedId],
      );
      assert.deepEqual(rows[0].applied_disclosures, {
        approvedPageBlocks: [],
        ...disclosures,
      });

      async function facts() {
        const { rows } = await db.query(
          `SELECT m.source_key AS key, to_jsonb(l) - 'ingested_at' - 'source_updated_at' AS facts
        FROM idx.source_mappings m JOIN idx.listings l ON l.id = m.listing_id
        WHERE m.feed_id = $1 ORDER BY m.source_key`,
          [state.feedId],
        );
        return rows;
      }
      assertRun(await state.run(feed), { code: "complete" });
      const [before, untouched] = await facts();
      assert.deepEqual(await state.run(feed), {
        code: "complete",
        counts: { accepted: 1, rejected: 0, rejectedByCode: {} },
      });
      assert.deepEqual(await facts(), [
        { ...before, facts: { ...before.facts, price: 225 } },
        untouched,
      ]);
      assert.deepEqual(await state.facts(), [
        { key: first.ListingKey, price: "225.00", revision: thirdMark },
        { key: second.ListingKey, price: "200.00", revision: secondMark },
      ]);
    },
  );

  await t.test(
    "retrying after a final commit polls from the saved mark",
    async (t) => {
      const state = await setup(t, "lost_final_ack");
      const bad = { ...second, ListPrice: 200 };
      const feed = await standIn(t, (url) =>
        url.search === "" ? page([first], "?cursor=2") : page([bad]),
      );
      assertRun(await state.run(feed, writer, 1), pageLimitReached);

      const query = writer.query.bind(writer);
      const fault = t.mock.method(
        writer,
        "query",
        async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (sql === "COMMIT")
            throw new Error("Synthetic lost acknowledgement");
          return result;
        },
      );
      try {
        assertRun(await state.run(feed, writer, 1), writeFailed);
      } finally {
        fault.mock.restore();
      }
      assertRun(await state.status(), {
        lastOutcome: { code: "complete" },
        lastRun: {
          kind: "incremental",
          counts: {
            accepted: 1,
            rejected: 1,
            rejectedByCode: { invalid_change: 1 },
          },
        },
      });
      assert.deepEqual(await state.checkpoint(), {
        version: 2n,
        position: complete(secondMark),
      });
      await assertFresh(state);
      const freshness = await state.freshness();
      const peer = await connectWriter(t);
      assertRun(await state.run(feed, peer, 1), {
        code: "complete",
        counts: {
          accepted: 0,
          rejected: 1,
          rejectedByCode: { invalid_change: 1 },
        },
      });
      assert.deepEqual(await state.checkpoint(), {
        version: 3n,
        position: complete(secondMark),
      });
      assert.deepEqual(await state.freshness(), freshness);
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", "?cursor=2", filter(secondMark)],
      );
    },
  );

  await t.test(
    "a legacy partial poll without counts restarts from its completed mark",
    async (t) => {
      const state = await setup(t, "legacy_partial");
      const feed = await standIn(t, (url) =>
        page(
          url.searchParams.has("cursor") ? [] : [{ ...third, ListPrice: 300 }],
        ),
      );
      await db.query(
        `INSERT INTO idx.feed_sync_positions
          (feed_id, version, completed_mark, next_link, pending_mark, record_state)
        VALUES ($1, 1, $2, $3, $4, 'rejected')`,
        [state.feedId, firstMark, feed.propertyUrl + "?cursor=old", secondMark],
      );
      const freshness = await state.freshness();
      assertRun(await state.run(feed), {
        code: "complete",
        counts: {
          accepted: 0,
          rejected: 1,
          rejectedByCode: { invalid_change: 1 },
        },
      });
      assert.equal(feed.calls[0].query, filter(firstMark));
      assert.deepEqual(await state.freshness(), freshness);
    },
  );

  await t.test(
    "bounded runs match the unlimited load and renew freshness only on completion",
    async (t) => {
      const runtime = new pg.Client({
        connectionString: process.env.RUNTIME_DATABASE_URL,
      });
      await runtime.connect();
      t.after(() => runtime.end());
      const siteId = "site_sync_limit";
      const secret = "synthetic-sync-limit-key";
      const app = createApp(repository(runtime), contract, "test", () => {});
      const search = "/api/v1/listings";
      const records = [
        third,
        first,
        second,
        record("fourth", firstMark),
        record("fifth", secondMark),
      ];
      const cursors = ["", "?cursor=1", "?cursor=2", "?cursor=3", "?cursor=4"];
      // Replay the same generated IDs from an empty feed for each run.
      const ids = records.map(() => crypto.randomUUID());
      let expected: unknown;
      for (const limit of [undefined, 2, 1]) {
        await t.test(`pages per call: ${limit ?? "unlimited"}`, async (t) => {
          const state = await setup(t, "limit", siteId);
          await db.query(
            `INSERT INTO idx.site_secret_keys (id, site_id, secret_hash, scopes)
            VALUES ('key_sync_limit', $1, $2, ARRAY['listings:read'])`,
            [siteId, await hashSecret(secret)],
          );
          let id = 0;
          const feed = await standIn(t, (url) => {
            const index = Number(url.searchParams.get("cursor"));
            return page([records[index]], cursors[index + 1]);
          });
          const statements = countWriterStatements(t, writer);
          const initialFreshness = await state.freshness();
          const batch = limit ?? records.length;
          for (let start = 0; start < records.length; start += batch) {
            const end = Math.min(start + batch, records.length);
            const final = end === records.length;
            const before = statements();
            const generator = t.mock.method(
              crypto,
              "randomUUID",
              () => ids[id++],
            );
            let result;
            try {
              result = await state.run(feed, writer, limit);
            } finally {
              generator.mock.restore();
            }
            assert.deepEqual(result, {
              ...(final ? { code: "complete" } : pageLimitReached),
              counts: { accepted: end, rejected: 0, rejectedByCode: {} },
            });
            assert.equal(
              statements() - before,
              1 + (end - start) * 7 + (start === 0 ? 1 : 0) + (final ? 3 : 0),
            );
            assert.deepEqual(
              feed.calls.map(({ query }) => query),
              cursors.slice(0, end),
            );
            assert.equal((await state.listings()).length, end);
            const response = await app.request(search, {
              headers: { Authorization: `Bearer ${secret}` },
            });
            const body = await response.json();
            validateResponse(search, response, body);
            assert.equal(response.status, final ? 200 : 503);
            if (final) {
              assert.deepEqual(
                body.data.map(({ id }: { id: string }) => id).sort(),
                ids.map((id) => `lst_${id}`).sort(),
              );
            } else {
              assert.equal(body.code, "feed_expired");
              assert.deepEqual(await state.freshness(), initialFreshness);
              assert.equal(
                (await state.checkpoint()).position.completedMark,
                null,
              );
            }
          }
          assert.deepEqual(await state.checkpoint(), {
            version: 5n,
            position: complete(thirdMark),
          });
          await assertFresh(state);
          await assertOutcome(state, {
            code: "complete",
            status: null,
            step: null,
            version: 5,
          });
          const listings = await state.listings();
          if (limit === undefined) expected = listings;
          else assert.deepEqual(listings, expected);
        });
      }
    },
  );

  await t.test(
    "pausing preserves a saved failure and a later failure inside the limit is saved",
    async (t) => {
      const state = await setup(t, "limit_outcome");
      const feed = await standIn(t, (_url, n) => {
        if (n === 1) return { status: 401 };
        if (n === 2) return page([first], "?cursor=2");
        if (n === 3) return page([second], "?cursor=3");
        return { status: 503 };
      });
      assertRun(await state.run(feed), stopHttpError);
      const outcome = await state.outcome();
      assertRun(await state.run(feed, writer, 1), pageLimitReached);
      assert.deepEqual(await state.outcome(), outcome);
      assertRun(await state.run(feed, writer, 2), retryHttpError);
      await assertOutcome(state, {
        code: "http_error",
        status: 503,
        step: "retry",
        version: 2,
      });
    },
  );

  await t.test(
    "invalid page limits are refused before reading the checkpoint or fetching",
    async (t) => {
      const state = await setup(t, "invalid_limit");
      const feed = await standIn(t, () => page([]));
      const statements = countWriterStatements(t, writer);
      for (const limit of [0, -1, 1.5, NaN, Infinity]) {
        await assert.rejects(state.run(feed, writer, limit), RangeError);
      }
      assert.equal(statements(), 0);
      assert.equal(feed.calls.length, 0);
    },
  );

  await t.test(
    "finishes unordered pages and preserves the greatest source time",
    async (t) => {
      const state = await setup(t, "complete");
      const statements = countWriterStatements(t, writer);
      const offsets: number[] = [];
      const feed = await standIn(t, (_url, number) => {
        offsets.push(statements());
        if (number === 1) return page([third], `${propertyPath}/next?cursor=2`);
        if (number === 2) return page([first], "?cursor=3");
        return page([second]);
      });
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual([...offsets, statements()], [1, 9, 16, 26]);
      assert.deepEqual(feed.calls, [
        { path: propertyPath, query: "", authorized: true },
        { path: `${propertyPath}/next`, query: "?cursor=2", authorized: true },
        { path: `${propertyPath}/next`, query: "?cursor=3", authorized: true },
      ]);
      assert.deepEqual(await state.checkpoint(), {
        version: 3n,
        position: complete(thirdMark),
      });
      await assertFresh(state);
      const { stored, actual } = await state.oldestIngest();
      assert.ok(actual);
      assert.equal(stored, actual);
      assert.deepEqual(
        await state.facts(),
        [first, second, third].map((record) => ({
          key: record.ListingKey,
          price: record.ListPrice,
          revision: record.ModificationTimestamp,
        })),
      );
    },
  );

  await t.test(
    "a failed middle fetch resumes with the same facts as an uninterrupted run",
    async (t) => {
      const state = await setup(t, "resume");
      const uninterrupted = await setup(t, "uninterrupted");
      t.mock.timers.enable({
        apis: ["Date"],
        now: Date.parse("2026-11-04T00:00:00Z"),
      });
      let fail = true;
      const feed = await standIn(t, (url) => {
        const cursor = url.searchParams.get("cursor");
        if (!cursor) return page([third], "?cursor=2");
        if (cursor === "2") {
          if (fail) return { status: 503 };
          return page([second], "?cursor=3");
        }
        return page([first]);
      });
      const oldFreshness = await state.freshness();
      assertRun(await state.run(feed), retryHttpError);
      assert.deepEqual(await state.freshness(), oldFreshness);
      const saved = await state.checkpoint();
      assert.equal(saved.version, 1n);
      assert.equal(saved.position.completedMark, null);
      assert.equal(saved.position.pendingMark, thirdMark);
      assert.equal(new URL(saved.position.nextLink!).search, "?cursor=2");
      const [before] = await state.listings();
      assert.equal(before.key, third.ListingKey);
      const oldest = await state.oldestIngest();
      assert.equal(oldest.stored, null);
      assert.ok(oldest.actual);
      assert.equal(oldest.conservative, true);

      fail = false;
      const resumed = await state.run(feed);
      assert.deepEqual(resumed, {
        code: "complete",
        counts: { accepted: 3, rejected: 0, rejectedByCode: {} },
      });
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", "?cursor=2", "?cursor=2", "?cursor=3"],
      );
      assert.deepEqual(await uninterrupted.run(feed), resumed);
      assert.deepEqual(await state.facts(), await uninterrupted.facts());
      assert.equal(
        (await state.listings()).find(({ key }) => key === before.key)?.id,
        before.id,
      );
      assert.deepEqual(
        (await state.checkpoint()).position,
        complete(thirdMark),
      );
      await assertFresh(state);
    },
  );

  await t.test(
    "withdrawing the oldest listing leaves conservative freshness until completion",
    async (t) => {
      const state = await setup(t, "oldest_withdrawal");
      const initial = await standIn(t, (_url, n) =>
        n === 1 ? page([first], "?cursor=2") : page([second]),
      );
      assertRun(await state.run(initial), { code: "complete" });
      const before = await state.oldestIngest();
      assert.ok(before.stored);
      assert.equal(before.stored, before.actual);

      let fail = true;
      const withdrawn = {
        ...first,
        StandardStatus: "Withdrawn",
        ModificationTimestamp: thirdMark,
      };
      const feed = await standIn(t, (_url, n) => {
        if (n === 1) return page([withdrawn], "?cursor=2");
        if (fail) return { status: 503 };
        return page([]);
      });
      assertRun(await state.run(feed), retryHttpError);
      const partial = await state.oldestIngest();
      assert.equal(partial.stored, before.stored);
      assert.ok(partial.actual && partial.actual !== partial.stored);
      assert.equal(partial.conservative, true);

      fail = false;
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(await state.oldestIngest(), {
        stored: partial.actual,
        actual: partial.actual,
        conservative: true,
      });
    },
  );

  await t.test(
    "a committed page with a lost acknowledgement resumes with stable IDs",
    async (t) => {
      const state = await setup(t, "lost_ack");
      const feed = await standIn(t, (url) =>
        url.search ? page([first, second]) : page([first], "?cursor=2"),
      );
      const oldFreshness = await state.freshness();
      const query = writer.query.bind(writer);
      const fault = t.mock.method(
        writer,
        "query",
        async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (sql === "COMMIT")
            throw new Error("Synthetic lost acknowledgement");
          return result;
        },
      );
      try {
        assertRun(await state.run(feed), writeFailed);
      } finally {
        fault.mock.restore();
      }
      assert.deepEqual(await state.freshness(), oldFreshness);
      const [before] = await state.listings();
      assert.equal(before.key, first.ListingKey);
      assert.equal((await state.checkpoint()).version, 1n);

      const peer = await connectWriter(t);
      assertRun(await state.run(feed, peer), { code: "complete" });
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", "?cursor=2"],
      );
      const after = await state.listings();
      assert.deepEqual(after[0], before);
      assert.deepEqual(
        after.map(({ key }) => key),
        [first.ListingKey, second.ListingKey],
      );
      assert.deepEqual(
        (await state.checkpoint()).position,
        complete(secondMark),
      );
    },
  );

  await t.test(
    "a page and checkpoint both roll back before commit",
    async (t) => {
      const state = await setup(t, "rollback");
      const feed = await standIn(t, () => page([first]));
      const oldFreshness = await state.freshness();
      const query = writer.query.bind(writer);
      const fault = t.mock.method(
        writer,
        "query",
        async (sql: string, values?: unknown[]) => {
          if (sql === "COMMIT")
            throw new Error("Synthetic failure before commit");
          return query(sql, values);
        },
      );
      try {
        assertRun(await state.run(feed, writer, 1), writeFailed);
      } finally {
        fault.mock.restore();
      }
      assert.equal((await state.checkpoint()).version, 0n);
      await assertOutcome(state, {
        code: "write_failed",
        status: null,
        step: "retry",
        version: 0,
      });
      assertRun(await state.status(), {
        lastOutcome: { code: "write_failed" },
        lastRun: null,
      });
      assert.deepEqual(await state.listings(), []);
      assert.deepEqual(await state.freshness(), oldFreshness);
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", ""],
      );
    },
  );

  await t.test(
    "the inclusive filter replays ties and finds new records at the completed mark",
    async (t) => {
      const state = await setup(t, "ties");
      const tied = record("tied", firstMark);
      const feed = await standIn(t, (url, number) => {
        if (number === 1) return page([first]);
        const expression = url.searchParams.get("$filter");
        return page(
          expression === `ModificationTimestamp ge ${firstMark}`
            ? [tied, first]
            : [],
        );
      });
      assertRun(await state.run(feed), { code: "complete" });
      const [before] = await state.listings();
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", filter(firstMark)],
      );
      const after = await state.listings();
      assert.deepEqual(after[0], before);
      assert.deepEqual(
        after.map(({ key }) => key),
        [first.ListingKey, tied.ListingKey],
      );
      assert.deepEqual(
        (await state.checkpoint()).position,
        complete(firstMark),
      );
    },
  );

  await t.test(
    "a future-dated record cannot make the next poll skip a later withdrawal",
    async (t) => {
      const state = await setup(t, "future_revision");
      const future = record("future", futureMark);
      const withdrawal = {
        ...first,
        StandardStatus: "Withdrawn",
        ModificationTimestamp: secondMark,
      };
      const feed = await standIn(t, (url, number) => {
        const mark = url.searchParams.get("$filter")?.split(" ").at(-1);
        const records = number === 1 ? [first, future] : [withdrawal, future];
        return page(
          records.filter(
            ({ ModificationTimestamp }) =>
              !mark || ModificationTimestamp >= mark,
          ),
        );
      });

      assertRun(await state.run(feed), { code: "complete" });
      const position = (await state.checkpoint()).position;
      const live = await state.listings();
      assert.equal(live.length, 1);
      assert.equal(live[0].key, first.ListingKey);
      assert.equal(live[0].revision, firstMark);
      await assertFresh(state);
      assertRun(await state.run(feed), { code: "complete" });
      assert.equal(
        (await state.listings()).find(({ key }) => key === first.ListingKey)
          ?.revision,
        null,
      );
      assert.deepEqual(position, complete(firstMark));
      assert.deepEqual(
        (await state.checkpoint()).position,
        complete(secondMark),
      );
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", filter(firstMark)],
      );
    },
  );

  await t.test(
    "a first load with only invalid listing facts stays expired and reports rejections",
    async (t) => {
      const state = await setup(t, "invalid_facts");
      const feed = await standIn(t, () =>
        page([
          { ...first, ListPrice: 100 },
          { ...second, Address: undefined },
        ]),
      );
      const freshness = await state.freshness();
      const result = await state.run(feed);
      assert.deepEqual(await state.freshness(), freshness);
      const counts = {
        accepted: 0,
        rejected: 2,
        rejectedByCode: { invalid_change: 2 },
      };
      assert.deepEqual(result.counts, counts);
      assert.match(
        "message" in result ? (result.message ?? "") : "",
        /no feed record could be used/i,
      );
    },
  );

  await t.test(
    "repeated future-only polls and a rejected traversal leave freshness alone",
    async (t) => {
      const state = await setup(t, "rejected_only");
      const bad = { ...third, ListingKey: null };
      const future = record("future", futureMark);
      const feed = await standIn(t, (_url, number) => {
        if (number === 1) return page([first]);
        if (number <= 3) return page([future]);
        if (number === 4) return page([bad, future], "?cursor=empty");
        return page([]);
      });
      assertRun(await state.run(feed), { code: "complete" });
      await state.setOldFreshness();
      const freshness = await state.freshness();
      const checkpoint = await state.checkpoint();
      const { rejected } = await applyListingPage(
        writer,
        state.feedId,
        [
          { kind: "withdrawn", sourceKey: "", revision: thirdMark },
          {
            kind: "deleted",
            sourceKey: "Synthetic absent",
            revision: futureMark,
          },
        ],
        { incremental: { checkpoint, nextLink: null } },
      );
      assert.deepEqual(rejected, [
        { index: 0, code: "invalid_key", hidden: false },
        { index: 1, code: "future_revision", hidden: false },
      ]);
      assert.deepEqual(await state.freshness(), freshness);
      for (let poll = 0; poll < 2; poll += 1) {
        assertRun(await state.run(feed), { code: "complete" });
        assert.deepEqual(
          (await state.checkpoint()).position,
          complete(firstMark),
        );
        assert.deepEqual(await state.freshness(), freshness);
      }
      assertRun(await state.run(feed, writer, 1), pageLimitReached);
      const { position } = await state.checkpoint();
      assert.equal(position.completedMark, firstMark);
      assert.equal(position.pendingMark, null);
      assert.equal(position.recordState, "rejected");
      assert.equal(new URL(position.nextLink!).search, "?cursor=empty");

      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(await state.freshness(), freshness);
      assert.deepEqual(
        (await state.checkpoint()).position,
        complete(firstMark),
      );
      assertRun(await state.run(feed), { code: "complete" });
      await assertFresh(state);
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        [
          "",
          ...Array(3).fill(filter(firstMark)),
          "?cursor=empty",
          filter(firstMark),
        ],
      );
    },
  );

  await t.test(
    "a rejected middle page still resumes at a valid withdrawal",
    async (t) => {
      const state = await setup(t, "rejected_middle");
      const withdrawal = {
        ...first,
        StandardStatus: "Withdrawn",
        ModificationTimestamp: thirdMark,
      };
      const feed = await standIn(t, (_url, number) => {
        if (number === 1) return page([first]);
        if (number === 2) return page([second], "?cursor=rejected");
        if (number === 3)
          return page(
            [record("future", futureMark), { ...third, ListingKey: null }],
            "?cursor=withdrawal",
          );
        if (number === 4) return page([withdrawal]);
        return page([]);
      });
      assertRun(await state.run(feed), { code: "complete" });
      await state.setOldFreshness();
      const freshness = await state.freshness();
      for (const [index, cursor] of [
        "?cursor=rejected",
        "?cursor=withdrawal",
      ].entries()) {
        const result = await state.run(feed, writer, 1);
        assert.deepEqual(result, {
          ...pageLimitReached,
          counts: {
            accepted: 1,
            rejected: index * 2,
            rejectedByCode:
              index === 0 ? {} : { future_revision: 1, invalid_key: 1 },
          },
        });
        const { position } = await state.checkpoint();
        assert.equal(position.completedMark, firstMark);
        assert.equal(position.pendingMark, secondMark);
        assert.equal(new URL(position.nextLink!).search, cursor);
        assert.deepEqual(await state.freshness(), freshness);
      }
      assert.deepEqual(await state.run(feed, writer, 1), {
        code: "complete",
        counts: {
          accepted: 2,
          rejected: 2,
          rejectedByCode: { future_revision: 1, invalid_key: 1 },
        },
      });
      assert.deepEqual(
        (await state.checkpoint()).position,
        complete(thirdMark),
      );
      const [withdrawn] = await state.listings();
      assert.equal(withdrawn.key, first.ListingKey);
      assert.equal(withdrawn.revision, null);
      await assertFresh(state);
      assertRun(await state.run(feed, writer, 1), { code: "complete" });
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        [
          "",
          filter(firstMark),
          "?cursor=rejected",
          "?cursor=withdrawal",
          filter(thirdMark),
        ],
      );
    },
  );

  await t.test(
    "future-dated withdrawals take listings down at their last trusted revision",
    async (t) => {
      const state = await setup(t, "future_withdrawal");
      const removals = [
        { ...first, StandardStatus: "Withdrawn" },
        { ...second, StandardStatus: "Unknown synthetic status" },
        { ...third, InternetEntireListingDisplayYN: false },
      ].map((record) => ({ ...record, ModificationTimestamp: futureMark }));
      const restored = {
        ...third,
        ModificationTimestamp: "2026-11-04T00:00:00.000000Z",
      };
      const feed = await standIn(t, (_url, number) => {
        if (number === 1) return page([first, second, third]);
        if (number === 2) return page(removals);
        if (number === 3) return page([third]);
        return page([restored]);
      });

      assertRun(await state.run(feed), { code: "complete" });
      await state.setOldFreshness();
      const freshness = await state.freshness();
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(
        (await state.listings()).map(({ revision }) => revision),
        [null, null, null],
      );
      assert.deepEqual(
        (await state.checkpoint()).position,
        complete(thirdMark),
      );
      assert.deepEqual(await state.freshness(), freshness);
      assertRun(await state.run(feed), { code: "complete" });
      assert.equal((await state.listings())[2].revision, null);
      assertRun(await state.run(feed), { code: "complete" });
      assert.equal(
        (await state.listings())[2].revision,
        restored.ModificationTimestamp,
      );
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", ...Array(3).fill(filter(thirdMark))],
      );
    },
  );

  await t.test(
    "an accepted restoration wins over a future withdrawal on the same page",
    async (t) => {
      const state = await setup(t, "future_and_restoration");
      const future = {
        ...first,
        StandardStatus: "Withdrawn",
        ModificationTimestamp: futureMark,
      };
      const restored = { ...first, ModificationTimestamp: secondMark };
      const responses = [
        [first],
        [future],
        [future, restored],
        [restored],
        [restored, future],
      ];
      const feed = await standIn(t, (_url, n) => page(responses[n - 1]));
      assertRun(await state.run(feed), { code: "complete" });
      assertRun(await state.run(feed), { code: "complete" });
      assert.equal((await state.listings())[0].revision, null);
      for (let n = 3; n <= responses.length; n += 1) {
        assertRun(await state.run(feed), { code: "complete" });
        assert.equal((await state.listings())[0].revision, secondMark);
        assert.deepEqual(
          (await state.checkpoint()).position,
          complete(secondMark),
        );
      }
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        [
          "",
          filter(firstMark),
          filter(firstMark),
          filter(secondMark),
          filter(secondMark),
        ],
      );
    },
  );

  await t.test(
    "accepts a revision at five minutes and rejects the next microsecond",
    async (t) => {
      t.mock.timers.enable({
        apis: ["Date"],
        now: Date.parse("2026-11-03T00:00:00Z"),
      });
      const state = await setup(t, "clock_allowance");
      const boundary = "2026-11-03T00:05:00.000000Z";
      const atBoundary = record("at boundary", boundary);
      const pastBoundary = record(
        "past boundary",
        "2026-11-03T00:05:00.000001Z",
      );
      const feed = await standIn(t, (_url, n) =>
        page(n === 1 ? [atBoundary] : [pastBoundary]),
      );
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual((await state.checkpoint()).position, complete(boundary));
      await assertFresh(state);
      await state.setOldFreshness();
      const freshness = await state.freshness();
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual((await state.checkpoint()).position, complete(boundary));
      assert.deepEqual(await state.freshness(), freshness);
      assert.deepEqual(
        (await state.listings()).map(({ revision }) => revision),
        [boundary],
      );
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", filter(boundary)],
      );
    },
  );

  await t.test(
    "an empty continuation across bounded runs still renews freshness",
    async (t) => {
      const state = await setup(t, "empty_continuation");
      const feed = await standIn(t, (_url, number) =>
        number === 1 ? page([], "?cursor=empty") : page([]),
      );
      const freshness = await state.freshness();
      assertRun(await state.run(feed, writer, 1), pageLimitReached);
      assert.deepEqual(await state.freshness(), freshness);
      assertRun(await state.run(feed, writer, 1), { code: "complete" });
      await assertFresh(state);
      assert.deepEqual((await state.checkpoint()).position, complete(null));
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", "?cursor=empty"],
      );
    },
  );

  await t.test(
    "older pages keep both marks from moving backward",
    async (t) => {
      const state = await setup(t, "older_pages");
      const feed = await standIn(t, (_url, number) => {
        if (number === 1) return page([third]);
        if (number === 2) return page([first], "?cursor=older");
        if (number === 3) return { status: 503 };
        return page([second]);
      });
      assertRun(await state.run(feed), { code: "complete" });
      assertRun(await state.run(feed), retryHttpError);
      const { position } = await state.checkpoint();
      assert.equal(position.completedMark, thirdMark);
      assert.equal(position.pendingMark, thirdMark);
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(await state.checkpoint(), {
        version: 3n,
        position: complete(thirdMark),
      });
    },
  );

  for (const status of [400, 410]) {
    await t.test(
      `${status} on a continuation clears only in-progress state and stops`,
      async (t) => {
        const state = await setup(t, `expired_${status}`);
        const feed = await standIn(t, (_url, number) => {
          if (number === 1) return page([first]);
          if (number === 2)
            return page(
              [third, { ...second, ListingKey: "" }],
              "?cursor=expired",
            );
          if (number === 3) return { status };
          if (number === 4) return page([third, first], "?cursor=fresh");
          return page([second]);
        });
        assertRun(await state.run(feed), { code: "complete" });
        const finished = (await state.status())?.lastRun;
        assert.ok(finished);
        const freshness = await state.freshness();
        assertRun(await state.run(feed), {
          code: "continuation_rejected",
          nextStep: retry,
          counts: {
            accepted: 1,
            rejected: 1,
            rejectedByCode: { invalid_key: 1 },
          },
        });
        assert.deepEqual((await state.status())?.lastRun, finished);
        await assertOutcome(state, {
          code: "continuation_rejected",
          status,
          step: "retry",
          version: 3,
        });
        assert.deepEqual(await state.checkpoint(), {
          version: 3n,
          position: complete(firstMark),
        });
        assert.deepEqual(await state.freshness(), freshness);
        const applied = await state.listings();
        assert.deepEqual(
          applied.map(({ key }) => key),
          [first.ListingKey, third.ListingKey],
        );
        assertRun(await state.run(feed), { code: "complete" });
        assert.deepEqual(
          feed.calls.map(({ query }) => query),
          [
            "",
            filter(firstMark),
            "?cursor=expired",
            filter(firstMark),
            "?cursor=fresh",
          ],
        );
        const final = await state.listings();
        assert.equal(final.length, 3);
        assert.deepEqual([final[0], final[2]], applied);
        assert.deepEqual(
          (await state.checkpoint()).position,
          complete(thirdMark),
        );
      },
    );
  }

  await t.test(
    "an empty restart rescan accounts for a committed page before a rejected continuation",
    async (t) => {
      const state = await setup(t, "empty_restart");
      const feed = await standIn(t, (_url, number) => {
        if (number === 1) return page([first], "?cursor=expired");
        if (number === 2) return { status: 410 };
        return page([]);
      });
      assertRun(await state.run(feed), { code: "continuation_rejected" });
      const partial = await state.oldestIngest();
      assert.equal(partial.stored, null);
      assert.ok(partial.actual);

      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(await state.oldestIngest(), {
        stored: partial.actual,
        actual: partial.actual,
        conservative: true,
      });
      await assertFresh(state);
    },
  );

  await t.test(
    "a runner with a stale position stops without applying its page",
    async (t) => {
      const state = await setup(t, "competing");
      const peer = await connectWriter(t);
      let arrive!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stale = record("stale", thirdMark);
      const feed = await standIn(t, async (_url, number) => {
        if (number === 1) return page([first], "?cursor=2");
        if (number === 2) return { status: 503 };
        if (number === 3) {
          arrive();
          await released;
          return page([stale], "?cursor=stale");
        }
        if (number === 4) return page([second], "?cursor=3");
        return page([third]);
      });
      assertRun(await state.run(feed), retryHttpError);
      const losing = state.run(feed, peer);
      let winningOutcome;
      try {
        await Promise.race([arrived, losing]);
        assertRun(await state.run(feed), { code: "complete" });
        winningOutcome = await state.outcome();
      } finally {
        release();
      }
      const freshness = await state.freshness();
      assertRun(await losing, {
        code: "position_changed",
        nextStep: { kind: "none" },
      });
      assert.equal(winningOutcome.code, "complete");
      assert.deepEqual(await state.outcome(), winningOutcome);
      assert.deepEqual(await state.checkpoint(), {
        version: 3n,
        position: complete(thirdMark),
      });
      assert.deepEqual(await state.freshness(), freshness);
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", "?cursor=2", "?cursor=2", "?cursor=2", "?cursor=3"],
      );
      assert.deepEqual(
        (await state.listings()).map(({ key }) => key),
        [first.ListingKey, second.ListingKey, third.ListingKey],
      );
    },
  );

  await t.test(
    "a stop at a lower position version leaves the newer outcome intact",
    async (t) => {
      const state = await setup(t, "stale_outcome");
      const peer = await connectWriter(t);
      const winner = await standIn(t, () => page([first]));
      let winningOutcome;
      const stale = await standIn(t, async () => {
        assertRun(await state.run(winner, peer), { code: "complete" });
        winningOutcome = await state.outcome();
        return { status: 401 };
      });
      assertRun(await state.run(stale), stopHttpError);
      assert.deepEqual(await state.outcome(), winningOutcome);
      assert.deepEqual(await state.checkpoint(), {
        version: 1n,
        position: complete(firstMark),
      });
    },
  );

  await t.test(
    "a delayed completion leaves a stop at the same position version intact",
    async (t) => {
      const state = await setup(t, "same_version");
      const peer = await connectWriter(t);
      const feed = await standIn(t, (_url, number) =>
        number === 1 ? page([first]) : { status: 401 },
      );
      const query = writer.query.bind(writer);
      t.mock.method(
        writer,
        "query",
        async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (sql === "COMMIT") {
            assertRun(await state.run(feed, peer), stopHttpError);
          }
          return result;
        },
      );
      assertRun(await state.run(feed), { code: "complete" });
      await assertOutcome(state, {
        code: "http_error",
        status: 401,
        step: "stop",
        version: 1,
      });
    },
  );

  await t.test(
    "a refused final report rolls back the page and freshness",
    async (t) => {
      const state = await setup(t, "outcome_denied");
      const feed = await standIn(t, (_url, number) =>
        number === 1 ? page([first]) : { status: 401 },
      );
      const grants = await readFile(
        new URL(
          "../../packages/engine/setup/listing-writer.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await db.query(
        "REVOKE ALL ON idx.feed_sync_outcomes FROM idx_listing_writer",
      );
      try {
        assertRun(await state.run(feed), {
          ...writeFailed,
          outcomeSaved: false,
        });
        assert.deepEqual(await state.checkpoint(), {
          version: 0n,
          position: complete(null),
        });
        assert.deepEqual(await state.listings(), []);
        assert.equal(
          (await state.freshness()).refreshed_at.getTime(),
          Date.parse(initialRefresh),
        );
        assertRun(await state.run(feed), {
          ...stopHttpError,
          outcomeSaved: false,
        });
        assert.equal(await state.outcome(), undefined);
      } finally {
        await db.query(grants);
      }
    },
  );

  await t.test(
    "a complete empty poll renews freshness and keeps the completed mark",
    async (t) => {
      const state = await setup(t, "empty");
      const feed = await standIn(t, (_url, number) =>
        page(number === 1 ? [first] : []),
      );
      assertRun(await state.run(feed), { code: "complete" });
      const before = await state.listings();
      await state.setOldFreshness();
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(await state.checkpoint(), {
        version: 2n,
        position: complete(firstMark),
      });
      assert.deepEqual(await state.listings(), before);
      await assertFresh(state);
    },
  );

  await t.test(
    "outside continuations and HTTP redirects never receive the bearer token",
    async (t) => {
      const state = await setup(t, "boundary");
      const outsideRequests: (string | undefined)[] = [];
      const outside = await listenOnLoopback((request, response) => {
        outsideRequests.push(request.headers.authorization);
        response.end("{}");
      });
      t.after(() => outside.close());
      const external = `${outside.baseUrl}${propertyPath}?cursor=external`;
      const links = [
        external,
        `${propertyPath}-other?cursor=sibling`,
        `${propertyPath}/%2f..%2foutside?cursor=encoded`,
      ];
      const feed = await standIn(t, (_url, number) => {
        const link = links[number - 1];
        if (link) return page([first], link);
        return { status: 307, location: external };
      });
      const freshness = await state.freshness();
      for (const link of links) {
        assertRun(
          await state.run(feed),
          { code: "invalid_link", nextStep: stop },
          link,
        );
      }
      assertRun(await state.run(feed), stopHttpError);
      assert.deepEqual(outsideRequests, []);
      assert.deepEqual(
        feed.calls,
        Array(4).fill({
          path: propertyPath,
          query: "",
          authorized: true,
        }),
      );
      assert.equal((await state.checkpoint()).version, 0n);
      assert.deepEqual(await state.listings(), []);
      assert.deepEqual(await state.freshness(), freshness);
    },
  );

  await t.test(
    "remote HTTP is refused before fetch and loopback HTTP works",
    async (t) => {
      const state = await setup(t, "refused");
      const checkpoint = await state.checkpoint();
      const freshness = await state.freshness();
      const feed = await standIn(t, () => page([]));
      const remote = new ResoConnector(
        "http://feed.example.invalid/Property",
        "synthetic-feed-token",
      );
      const fetch = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response(),
      );
      try {
        assert.deepEqual(await remote.readPage(null, null), {
          code: "invalid_link",
        });
        assertRun(await state.run({ connector: remote }), {
          code: "invalid_link",
          nextStep: stop,
        });
        assert.equal(fetch.mock.callCount(), 0);
      } finally {
        fetch.mock.restore();
      }
      await assertOutcome(state, {
        code: "invalid_link",
        status: null,
        step: "stop",
        version: 0,
      });
      assert.deepEqual(await state.checkpoint(), checkpoint);
      assert.deepEqual(await state.freshness(), freshness);
      assert.deepEqual(await feed.connector.readPage(null, null), {
        code: "page",
        records: [],
        nextLink: null,
      });
      assert.deepEqual(feed.calls, [
        { path: propertyPath, query: "", authorized: true },
      ]);
    },
  );

  await t.test(
    "blank and self-referencing links keep the saved page untouched",
    async (t) => {
      const state = await setup(t, "malformed_links");
      const cursor = "?cursor=pending";
      const feed = await standIn(t, (_url, number) => {
        if (number === 1) return page([first], cursor);
        if (number === 2) return { status: 503 };
        if (number === 3) return page([second], " \t ");
        if (number === 4) return page([second], cursor);
        return page([second]);
      });
      assertRun(await state.run(feed), retryHttpError);
      const checkpoint = await state.checkpoint();
      const listings = await state.listings();
      const freshness = await state.freshness();
      for (const requestCount of [3, 4]) {
        assertRun(await state.run(feed), {
          code: "invalid_page",
          nextStep: retry,
        });
        assert.equal(feed.calls.length, requestCount);
        assert.deepEqual(await state.checkpoint(), checkpoint);
        assert.deepEqual(await state.listings(), listings);
        assert.deepEqual(await state.freshness(), freshness);
      }
    },
  );

  await t.test(
    "HTTP failures make one request and save safe guidance",
    async (t) => {
      const state = await setup(t, "http_outcomes");
      const retryIn120 = { ...retry, afterSeconds: 120 };
      const retryInOneSecond = { ...retry, afterSeconds: 1 };
      const retryInOneDay = { ...retry, afterSeconds: 86_400 };
      const cases: {
        status: number;
        retryAfter?: string;
        nextStep: FeedNextStep;
      }[] = [
        { status: 429, retryAfter: "120", nextStep: retryIn120 },
        { status: 503, retryAfter: "120", nextStep: retryIn120 },
        { status: 429, retryAfter: "0", nextStep: retryInOneSecond },
        { status: 503, retryAfter: "9".repeat(400), nextStep: retryInOneDay },
        {
          status: 503,
          retryAfter: "Sun, 06 Nov 1994 08:49:37 GMT",
          nextStep: retry,
        },
        { status: 429, retryAfter: "synthetic retry header", nextStep: retry },
        { status: 500, retryAfter: "120", nextStep: retry },
        { status: 408, nextStep: retry },
        { status: 400, nextStep: stop },
        { status: 401, nextStep: stop },
        { status: 403, nextStep: stop },
        { status: 404, nextStep: stop },
      ];
      const feed = await standIn(
        t,
        (_url, number) => cases[number - 1] ?? page([]),
      );
      const methods = ["log", "warn", "error"] as const;
      const logs = methods.map((method) =>
        t.mock.method(console, method, () => {}),
      );
      const checkpoint = await state.checkpoint();
      const freshness = await state.freshness();
      for (const [index, { status, nextStep }] of cases.entries()) {
        assertRun(await state.run(feed), {
          code: "http_error",
          nextStep,
        });
        assert.equal(feed.calls.length, index + 1);
        await assertOutcome(state, {
          code: "http_error",
          status,
          step: nextStep.kind,
          version: 0,
          afterSeconds:
            nextStep.kind === "retry" ? nextStep.afterSeconds : undefined,
        });
        assert.deepEqual(await state.checkpoint(), checkpoint);
        assert.deepEqual(await state.freshness(), freshness);
      }
      assertRun(await state.run(feed), { code: "complete" });
      await assertOutcome(state, {
        code: "complete",
        status: null,
        step: null,
        version: 1,
      });
      assert.equal((await state.checkpoint()).version, 1n);
      await assertFresh(state);
      assert.deepEqual(
        logs.map(({ mock }) => mock.calls),
        [[], [], []],
      );
    },
  );

  await t.test(
    "oversized pages stop at the header or the first chunk over the limit",
    async (t) => {
      const state = await setup(t, "oversized");
      const checkpoint = await state.checkpoint();
      const freshness = await state.freshness();
      const connector = new ResoConnector(
        "https://feed.example.invalid/Property",
        feedToken,
      );
      const chunk = new Uint8Array(1024 * 1024).fill(0x20);
      let response: Response;
      t.mock.method(globalThis, "fetch", async () => response);
      for (const declaredChunks of [12, null, 1]) {
        let reads = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              // Leave invalid JSON at EOF if the connector reads this far.
              if (reads <= 12) controller.enqueue(chunk);
              else controller.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        const headers = new Headers();
        if (declaredChunks !== null)
          headers.set("Content-Length", String(declaredChunks * chunk.length));
        response = new Response(body, { headers });

        assertRun(await state.run({ connector }), {
          code: "page_too_large",
          nextStep: stop,
        });
        assert.equal(reads, declaredChunks === 12 ? 0 : 9);
        assert.ok(cancelled);
        await assertOutcome(state, {
          code: "page_too_large",
          status: 200,
          step: "stop",
          version: 0,
        });
        assert.deepEqual(await state.checkpoint(), checkpoint);
        assert.deepEqual(await state.freshness(), freshness);
      }
    },
  );

  await t.test(
    "fetch failures are redacted and keep the saved page available to retry",
    async (t) => {
      const state = await setup(t, "fetch_failures");
      const feed = await standIn(
        t,
        (_url, number) => {
          if (number === 1) return page([first], "?cursor=retry-marker");
          if (number === 2) return { status: 429 };
          if (number === 3) return "disconnect";
          if (number === 4) return "invalid_json";
          if (number === 5) return page([], "");
          if (number === 6) return "stall";
          return page([second]);
        },
        1_000,
      );
      const freshness = await state.freshness();
      assertRun(await state.run(feed), retryHttpError);
      await assertOutcome(state, {
        code: "http_error",
        status: 429,
        step: "retry",
        version: 1,
      });
      const checkpoint = await state.checkpoint();
      const before = await state.listings();
      const failures = [
        "fetch_failed",
        "invalid_page",
        "invalid_page",
        "fetch_timeout",
      ];
      for (const code of failures) {
        assertRun(await state.run(feed), { code, nextStep: retry });
        await assertOutcome(state, {
          code,
          status: 200,
          step: "retry",
          version: 1,
        });
        assert.deepEqual(await state.checkpoint(), checkpoint);
        assert.deepEqual(await state.listings(), before);
        assert.deepEqual(await state.freshness(), freshness);
      }
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", ...Array(6).fill("?cursor=retry-marker")],
      );
    },
  );

  await t.test(
    "an unreadable listing still reaches the writer and withdraws its prior facts",
    async (t) => {
      const state = await setup(t, "unreadable");
      const feed = await standIn(t, (_url, number) =>
        number === 1
          ? page([first])
          : page([
              null,
              record("first", secondMark, "invalid synthetic price"),
            ]),
      );
      assertRun(await state.run(feed), { code: "complete" });
      const [before] = await state.listings();
      assert.equal(before.price, first.ListPrice);
      await state.setOldFreshness();
      const freshness = await state.freshness();
      assertRun(await state.run(feed), { code: "complete" });
      assert.deepEqual(await state.freshness(), freshness);
      assert.deepEqual(await state.listings(), [
        { key: before.key, id: before.id, price: null, revision: null },
      ]);
      assert.deepEqual(
        (await state.checkpoint()).position,
        complete(secondMark),
      );
    },
  );
});
