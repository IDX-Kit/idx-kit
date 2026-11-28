import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pg from "pg";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { readScanCheckpoint } from "@idx-kit/engine/src/db/feed-scan-positions.ts";
import { readFeedState } from "@idx-kit/engine/src/db/feed-sync-outcomes.ts";
import { readFeedCheckpoint } from "@idx-kit/engine/src/db/feed-sync-positions.ts";
import { repository } from "@idx-kit/engine/src/db/read.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { hashSecret } from "@idx-kit/engine/src/domain/keys.ts";
import { createApp } from "@idx-kit/engine/src/http/app.ts";
import { syncFullScan } from "@idx-kit/engine/src/sync/full-scan.ts";
import { syncIncrementally } from "@idx-kit/engine/src/sync/incremental.ts";
import { contract, validateResponse } from "../api/contract.ts";
import { fixtureDisclosures } from "../api/listing-page.ts";
import {
  connectWriter,
  countWriterStatements,
  page,
  propertyPath,
  readOldestIngest,
  standIn,
} from "./feed.ts";

const assertRun = assert.partialDeepStrictEqual;
const none = { kind: "none" };
const complete = { code: "complete", nextStep: none };
const revision = (n: number) => `2026-11-03T00:00:00.00000${n}Z`;
type Feed = Awaited<ReturnType<typeof standIn>>;

test("full listing scans over HTTP", { timeout: 45_000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.RUNTIME_DATABASE_URL);
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
  const writer = await connectWriter(t);
  const fixtures = await new FixtureConnector().read();
  const [fixtureFeed] = fixtures.feeds;
  const disclosures = fixtureDisclosures(fixtures, fixtureFeed.id);
  const record = (key: string, n = 1, price = "100.00") => ({
    ...fixtures.listings[0].source,
    ListingKey: `Synthetic scan ${key}`,
    ModificationTimestamp: revision(n),
    ListPrice: price,
  });
  const first = record("first");
  const second = record("second");
  const third = record("third");

  async function setup(
    t: TestContext,
    name: string,
    initial = [first, second, third],
  ) {
    const feedId = `feed_scan_${name}`;
    const siteId = `site_scan_${name}`;
    await seed(db, {
      feeds: [{ ...fixtureFeed, id: feedId }],
      sites: [{ id: siteId, feedIds: [feedId] }],
      listings: [],
    });
    t.after(async () => {
      await db.query("DELETE FROM idx.site_secret_keys WHERE site_id = $1", [
        siteId,
      ]);
      await db.query("DELETE FROM idx.data_licenses WHERE site_id = $1", [
        siteId,
      ]);
      await db.query("DELETE FROM idx.sites WHERE id = $1", [siteId]);
      await db.query(
        `DELETE FROM idx.listings l USING idx.source_mappings m
        WHERE l.id = m.listing_id AND m.feed_id = $1`,
        [feedId],
      );
      await db.query("DELETE FROM idx.source_mappings WHERE feed_id = $1", [
        feedId,
      ]);
      await db.query("DELETE FROM idx.feeds WHERE id = $1", [feedId]);
    });
    const options = (feed: Feed, notices = disclosures) => ({
      feedId,
      disclosures: notices,
      synthetic: true,
      connector: feed.connector,
    });
    const incremental = async (feed: Feed, client = writer) =>
      syncIncrementally(client, options(feed));
    const poll = async (records: unknown[], client = writer) => {
      const feed = await standIn(t, () => page(records));
      assert.equal((await incremental(feed, client)).code, "complete");
    };
    await poll(initial);
    return {
      feedId,
      siteId,
      poll,
      scan: (
        feed: Feed,
        maxRemovals?: number,
        client = writer,
        notices = disclosures,
      ) =>
        maxRemovals === undefined
          ? syncFullScan(client, options(feed, notices))
          : syncFullScan(client, {
              ...options(feed, notices),
              removeMissing: true,
              maxRemovals,
            }),
      checkpoint: () => readScanCheckpoint(db, feedId),
      lastRun: async () =>
        (await readFeedState(db, feedId, true))?.status.lastRun,
      oldestIngest: () => readOldestIngest(db, feedId),
      clearOldestIngest: () =>
        db.query(
          "UPDATE idx.feeds SET oldest_listing_ingested_at = NULL WHERE id = $1",
          [feedId],
        ),
      async incrementalState() {
        const { rows: feed } = await db.query(
          `SELECT id, refreshed_at, expires_at, display_blocks, rules_version
          FROM idx.feeds WHERE id = $1`,
          [feedId],
        );
        const { rows: outcomes } = await db.query(
          "SELECT * FROM idx.feed_sync_outcomes WHERE feed_id = $1",
          [feedId],
        );
        return {
          feed,
          outcomes,
          position: await readFeedCheckpoint(db, feedId),
        };
      },
      async listings() {
        const { rows } = await db.query<{
          id: string;
          key: string;
          facts: {
            price: number;
            display_blocks: unknown[];
            page_blocks: unknown[];
          } | null;
          revision: string | null;
          stamp: string | null;
        }>(
          `SELECT m.listing_id AS id, m.source_key AS key, to_jsonb(l) AS facts,
            CASE WHEN isfinite(m.source_revision)
              THEN to_char(m.source_revision AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              ELSE m.source_revision::text END AS revision,
            s.scan_number::text AS stamp
          FROM idx.source_mappings m LEFT JOIN idx.listings l ON l.id = m.listing_id
          LEFT JOIN idx.listing_scan_stamps s ON s.listing_id = m.listing_id
          WHERE m.feed_id = $1 ORDER BY m.source_key`,
          [feedId],
        );
        return rows;
      },
    };
  }

  await t.test(
    "repairs a missed edit and withdraws a missing listing from the API and storage",
    async (t) => {
      const state = await setup(t, "repair", [second]);
      await state.poll([first, third]);
      const secret = "synthetic-full-scan-read-key";
      await db.query(
        `INSERT INTO idx.site_secret_keys (id, site_id, secret_hash, scopes)
      VALUES ('key_scan_repair', $1, $2, ARRAY['listings:read'])`,
        [state.siteId, await hashSecret(secret)],
      );
      const app = createApp(repository(runtime), contract, "test", () => {});
      const [edited, missing, unchanged] = await state.listings();
      const search = "/api/v1/listings";
      const detail = `${search}/${missing.id}`;
      async function request(path: string, status: number) {
        const response = await app.request(path, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        assert.equal(response.status, status);
        const body = await response.json();
        validateResponse(
          path === search ? search : `${search}/{listingId}`,
          response,
          body,
        );
        return body;
      }

      assert.equal((await request(detail, 200)).data.id, missing.id);
      assert.equal((await request(search, 200)).data.length, 3);
      const incrementalState = await state.incrementalState();
      const oldest = await state.oldestIngest();
      const statements = countWriterStatements(t, writer);
      const offsets: number[] = [];
      const feed = await standIn(t, (_url, n) => {
        offsets.push(statements());
        return n === 1
          ? page(
              [record("first", 2, "225.00")],
              `${propertyPath}/next?cursor=2`,
            )
          : page([third]);
      });
      assertRun(await state.scan(feed, 1), {
        ...complete,
        pagesRead: 2,
        recordsSeen: 2,
        listingsRemoved: 1,
      });
      assert.deepEqual([...offsets, statements()], [6, 13, 22]);
      assert.deepEqual(feed.calls, [
        { path: propertyPath, query: "", authorized: true },
        { path: `${propertyPath}/next`, query: "?cursor=2", authorized: true },
      ]);
      assert.deepEqual(await state.incrementalState(), incrementalState);
      assert.equal((await request(detail, 404)).code, "not_found");
      const { data, display } = await request(search, 200);
      const { stored, actual } = await state.oldestIngest();
      assert.ok(actual && actual !== oldest.stored);
      assert.equal(stored, actual);
      assert.equal(
        display.freshness.ingestedAt,
        new Date(actual).toISOString(),
      );
      assert.deepEqual(
        data.map(({ id }: { id: string }) => id),
        [unchanged.id, edited.id],
      );
      assert.equal(data[1].price.amount, "225.00");
      const after = await state.listings();
      assert.equal(after[0].id, edited.id);
      assert.equal(after[0].facts?.price, 225);
      assert.deepEqual(after[1], { ...missing, facts: null });
      assert.deepEqual(after[2], { ...unchanged, stamp: "1" });
    },
  );

  await t.test(
    "a second scan starting after commit sees the first scan's report",
    async (t) => {
      const state = await setup(t, "scan_report_overlap");
      const peer = await connectWriter(t);
      const original = await standIn(t, () => page([first]));
      let during;
      const next = await standIn(t, async () => {
        during = await state.lastRun();
        return page([second, third]);
      });
      let commits = 0;
      const query = writer.query.bind(writer);
      t.mock.method(
        writer,
        "query",
        async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (sql === "COMMIT" && ++commits === 2) {
            assert.equal(
              (await state.scan(next, undefined, peer)).code,
              "complete",
            );
          }
          return result;
        },
      );
      const firstScan = await state.scan(original);
      assert.equal(firstScan.code, "complete");
      assertRun(during, { kind: "scan", counts: firstScan.counts });
      const after = await state.lastRun();
      assertRun(after, {
        kind: "scan",
        counts: { accepted: 2, rejected: 0, rejectedByCode: {} },
      });
    },
  );

  await t.test(
    "an all-rejected scan reports invalid facts and leaves feed freshness alone",
    async (t) => {
      const state = await setup(t, "invalid_facts");
      const before = await state.incrementalState();
      const bad = { ...record("bad"), ListPrice: 100 };
      const feed = await standIn(t, () => page([bad]));
      const result = await state.scan(feed);
      assert.deepEqual(result.counts, {
        accepted: 0,
        rejected: 1,
        rejectedByCode: { invalid_change: 1 },
      });
      assert.match(result.message ?? "", /no feed record could be used/i);
      assert.deepEqual(await state.incrementalState(), before);
    },
  );

  await t.test(
    "a resumed scan can withdraw after a nonempty first page and an empty final page",
    async (t) => {
      const state = await setup(t, "resume", [first]);
      await state.poll([second, third]);
      const before = await state.listings();
      const oldest = await state.oldestIngest();
      const feed = await standIn(t, (_url, n) => {
        if (n === 1)
          return page([record("first", 2, "225.00"), second], "?cursor=2");
        if (n === 2) return { status: 503, retryAfter: "120" };
        return page([]);
      });
      assertRun(await state.scan(feed, 1), {
        code: "http_error",
        nextStep: { kind: "retry", afterSeconds: 120 },
        pagesRead: 1,
        recordsSeen: 2,
        listingsRemoved: 0,
      });
      const pending = await state.checkpoint();
      assert.equal(pending.active, true);
      assert.equal(pending.recordsSeen, 2);
      assert.equal(new URL(pending.nextLink!).search, "?cursor=2");
      const [edited, ...others] = await state.listings();
      assert.equal(edited.id, before[0].id);
      assert.equal(edited.facts?.price, 225);
      assert.deepEqual(others, [
        { ...before[1], stamp: pending.scanNumber.toString() },
        before[2],
      ]);
      const partial = await state.oldestIngest();
      assert.equal(partial.stored, oldest.stored);
      assert.ok(partial.actual && partial.actual !== partial.stored);
      assert.equal(partial.conservative, true);
      assert.deepEqual(await state.scan(feed, 1), {
        ...complete,
        pagesRead: 1,
        recordsSeen: 0,
        listingsRemoved: 1,
        counts: { accepted: 2, rejected: 0, rejectedByCode: {} },
      });
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", "?cursor=2", "?cursor=2"],
      );
      assert.deepEqual(await state.checkpoint(), {
        version: pending.version + 1n,
        scanNumber: pending.scanNumber,
        active: false,
        nextLink: null,
        recordsSeen: 2,
        unreadableRecords: 0,
      });
      assert.equal((await state.listings())[2].facts, null);
      assert.equal((await state.oldestIngest()).stored, partial.actual);
    },
  );

  await t.test(
    "rejecting a continuation closes the scan and the next scan ignores its stamps",
    async (t) => {
      const state = await setup(t, "rejected");
      const finished = await state.lastRun();
      assert.ok(finished);
      const feed = await standIn(t, (_url, n) => {
        if (n === 1) return page([first], "?cursor=expired");
        if (n === 2) return { status: 410 };
        return page([second, third]);
      });
      assertRun(await state.scan(feed, 1), {
        code: "continuation_rejected",
        nextStep: { kind: "retry" },
        pagesRead: 1,
        recordsSeen: 1,
        listingsRemoved: 0,
        counts: { accepted: 1, rejected: 0, rejectedByCode: {} },
      });
      assert.deepEqual(await state.lastRun(), finished);
      const ended = await state.checkpoint();
      assert.equal(ended.active, false);
      assert.equal(ended.nextLink, null);
      assert.ok((await state.listings()).every(({ facts }) => facts !== null));
      assertRun(await state.scan(feed, 1), {
        ...complete,
        pagesRead: 1,
        recordsSeen: 2,
        listingsRemoved: 1,
      });
      assert.equal(
        (await state.checkpoint()).scanNumber,
        ended.scanNumber + 1n,
      );
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", "?cursor=expired", ""],
      );
      assert.equal((await state.listings())[0].facts, null);
    },
  );

  await t.test(
    "incremental additions, edits, replays and withdrawals survive a running scan",
    async (t) => {
      const withdrawn = record("withdrawn");
      const replay = record("replay", 2);
      const state = await setup(t, "interleaved", [
        first,
        second,
        third,
        withdrawn,
        replay,
      ]);
      const peer = await connectWriter(t);
      let afterPoll: Awaited<ReturnType<typeof state.listings>> | undefined;
      let pollState:
        Awaited<ReturnType<typeof state.incrementalState>> | undefined;
      const feed = await standIn(t, async (_url, n) => {
        if (n === 1) return page([third], "?cursor=2");
        await state.poll(
          [
            record("added", 3, "33.00"),
            record("first", 3, "333.00"),
            record("replay"),
            { ...record("withdrawn", 3), StandardStatus: "Withdrawn" },
          ],
          peer,
        );
        afterPoll = await state.listings();
        pollState = await state.incrementalState();
        return page([withdrawn]);
      });
      assertRun(await state.scan(feed, 1), {
        ...complete,
        pagesRead: 2,
        recordsSeen: 2,
        listingsRemoved: 1,
      });
      assert.deepEqual(await state.incrementalState(), pollState);
      const after = await state.listings();
      assert.deepEqual(
        after,
        afterPoll!.map((listing) =>
          listing.key === second.ListingKey
            ? { ...listing, facts: null }
            : listing,
        ),
      );
      assert.deepEqual(
        after.map(({ facts }) => facts?.price ?? null),
        [33, 333, 100, null, 100, null],
      );
    },
  );

  await t.test("the limit stops all absence withdrawals", async (t) => {
    const state = await setup(t, "limit");
    const before = await state.listings();
    const feed = await standIn(t, () => page([first]));
    for (const invalid of [-1, 1.5, Infinity]) {
      assertRun(await state.scan(feed, invalid), {
        code: "invalid_removal_limit",
        nextStep: { kind: "stop" },
        pagesRead: 0,
        recordsSeen: 0,
        listingsRemoved: 0,
      });
    }
    assert.equal(feed.calls.length, 0);
    await state.clearOldestIngest();
    assertRun(await state.scan(feed, 1), {
      code: "removal_limit_exceeded",
      nextStep: { kind: "stop" },
      pagesRead: 1,
      recordsSeen: 1,
      listingsRemoved: 0,
      wouldRemove: 2,
      maxRemovals: 1,
    });
    assert.equal((await state.checkpoint()).active, false);
    const { stored, actual } = await state.oldestIngest();
    assert.ok(actual);
    assert.equal(stored, actual);
    assert.deepEqual(
      (await state.listings()).map(({ facts }) => facts),
      before.map(({ facts }) => facts),
    );
  });

  await t.test(
    "status withdrawals apply even when absence withdrawals exceed the limit",
    async (t) => {
      const state = await setup(t, "status");
      const feed = await standIn(t, () =>
        page([
          { ...record("first", 2), StandardStatus: "Withdrawn" },
          { ...record("second", 2), StandardStatus: "Unrecognized" },
        ]),
      );
      assertRun(await state.scan(feed, 0), {
        code: "removal_limit_exceeded",
        nextStep: { kind: "stop" },
        pagesRead: 1,
        recordsSeen: 2,
        listingsRemoved: 0,
        wouldRemove: 1,
        maxRemovals: 0,
      });
      assert.deepEqual(
        (await state.listings()).map(({ facts }) => facts?.price ?? null),
        [null, null, 100],
      );
    },
  );

  await t.test(
    "an empty scan keeps listings even when the limit permits removing them all",
    async (t) => {
      const state = await setup(t, "empty", [first]);
      const before = await state.listings();
      const feed = await standIn(t, () => page([]));
      for (const maxRemovals of [0, 1]) {
        await state.clearOldestIngest();
        assertRun(await state.scan(feed, maxRemovals), {
          code: "empty_scan",
          nextStep: { kind: "stop" },
          pagesRead: 1,
          recordsSeen: 0,
          listingsRemoved: 0,
          wouldRemove: 1,
          maxRemovals,
        });
        assert.equal((await state.checkpoint()).active, false);
        const { stored, actual } = await state.oldestIngest();
        assert.ok(actual);
        assert.equal(stored, actual);
        assert.deepEqual(await state.listings(), before);
      }
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", ""],
      );
    },
  );

  await t.test(
    "an unreadable key on the final page blocks absence withdrawals but permits repairs",
    async (t) => {
      const state = await setup(t, "unreadable_final", [first, second]);
      const [before] = await state.listings();
      const feed = await standIn(t, () =>
        page([
          { ...first, ListingKey: undefined },
          record("second", 2, "225.00"),
        ]),
      );
      await state.clearOldestIngest();
      assertRun(await state.scan(feed, 1), {
        code: "unreadable_keys",
        nextStep: { kind: "stop" },
        pagesRead: 1,
        recordsSeen: 2,
        listingsRemoved: 0,
        unreadableRecords: 1,
      });
      assert.equal((await state.checkpoint()).active, false);
      const { stored, actual } = await state.oldestIngest();
      assert.ok(actual);
      assert.equal(stored, actual);
      const [kept, repaired] = await state.listings();
      assert.deepEqual(kept, before);
      assert.equal(repaired.facts?.price, 225);
    },
  );

  await t.test(
    "unreadable keys from an earlier page still block absence withdrawals after a resume",
    async (t) => {
      const state = await setup(t, "unreadable_resume");
      const before = await state.listings();
      const feed = await standIn(t, (_url, n) => {
        if (n === 1) {
          const oversized = { ...first, ListingKey: "a".repeat(1025) };
          return page([oversized, oversized, second], "?cursor=2");
        }
        if (n === 2) return { status: 503 };
        return page([record("third", 2, "225.00"), second]);
      });
      assertRun(await state.scan(feed, 1), {
        code: "http_error",
        nextStep: { kind: "retry" },
        pagesRead: 1,
        recordsSeen: 3,
        listingsRemoved: 0,
      });
      assert.equal((await state.checkpoint()).unreadableRecords, 2);
      assertRun(await state.scan(feed, 1), {
        code: "unreadable_keys",
        nextStep: { kind: "stop" },
        pagesRead: 1,
        recordsSeen: 2,
        listingsRemoved: 0,
        unreadableRecords: 2,
      });
      const [kept, , repaired] = await state.listings();
      assert.deepEqual(kept, before[0]);
      assert.equal(repaired.facts?.price, 225);
      assert.equal((await state.checkpoint()).active, false);
      assertRun(await state.scan(feed, 1), {
        ...complete,
        pagesRead: 1,
        recordsSeen: 2,
        listingsRemoved: 1,
      });
      assert.equal((await state.listings())[0].facts, null);
    },
  );

  await t.test(
    "repairs edits without removing missing listings unless requested",
    async (t) => {
      const state = await setup(t, "keep");
      const feed = await standIn(t, () => page([record("first", 2, "225.00")]));
      assertRun(await state.scan(feed), {
        ...complete,
        pagesRead: 1,
        recordsSeen: 1,
        listingsRemoved: 0,
      });
      assert.deepEqual(
        (await state.listings()).map(({ facts }) => facts?.price),
        [225, 100, 100],
      );
    },
  );

  await t.test(
    "an authoritative page restores a listing after an unreadable removal",
    async (t) => {
      const state = await setup(t, "unknown", [first]);
      const [before] = await state.listings();
      await state.poll([
        {
          ...first,
          StandardStatus: "Withdrawn",
          ModificationTimestamp: "unreadable",
        },
      ]);
      const [hidden] = await state.listings();
      assert.equal(hidden.facts, null);
      assert.equal(hidden.revision, "infinity");
      const feed = await standIn(t, () => page([first]));
      assertRun(await state.scan(feed, 0), {
        ...complete,
        pagesRead: 1,
        recordsSeen: 1,
        listingsRemoved: 0,
      });
      const [restored] = await state.listings();
      assert.equal(restored.id, before.id);
      assert.equal(restored.facts?.price, 100);
      assert.equal(restored.revision, before.revision);
    },
  );

  await t.test(
    "a competing runner cannot write a page after another runner finishes",
    async (t) => {
      const state = await setup(t, "competing");
      const peer = await connectWriter(t);
      const winner = await standIn(t, () => page([first, second]));
      let winningState:
        Awaited<ReturnType<typeof state.checkpoint>> | undefined;
      let winningListings:
        Awaited<ReturnType<typeof state.listings>> | undefined;
      const loser = await standIn(t, async () => {
        assertRun(await state.scan(winner, 1, peer), {
          ...complete,
          pagesRead: 1,
          recordsSeen: 2,
          listingsRemoved: 1,
        });
        winningState = await state.checkpoint();
        winningListings = await state.listings();
        return page([record("loser", 2), record("first", 2)]);
      });
      assertRun(await state.scan(loser, 1), {
        code: "position_changed",
        nextStep: none,
        pagesRead: 1,
        recordsSeen: 2,
        listingsRemoved: 0,
      });
      assert.deepEqual(await state.checkpoint(), winningState);
      assert.deepEqual(await state.listings(), winningListings);
      assert.equal((await state.checkpoint()).scanNumber, 1n);
    },
  );

  await t.test(
    "a failed competing scan can apply notices while the healthy scan finishes",
    async (t) => {
      const state = await setup(t, "competing_notices");
      const peer = await connectWriter(t);
      const notices = {
        approvedFeedBlocks: [
          { ...disclosures.approvedFeedBlocks[0], text: "New feed notice" },
        ],
        approvedListingBlocks: [
          {
            ...disclosures.approvedListingBlocks[0],
            text: "New listing notice",
          },
        ],
        approvedPageBlocks: [
          { ...disclosures.approvedFeedBlocks[0], id: "new_page_notice" },
        ],
      };
      let failed: Awaited<ReturnType<typeof state.scan>> | undefined;
      const feed = await standIn(t, async (_url, n) => {
        if (n === 1) return page([first], "?cursor=2");
        if (n === 3) return { status: 503 };
        failed = await state.scan(feed, undefined, peer, notices);
        return page([record("third", 2, "225.00")]);
      });
      const counts = { accepted: 2, rejected: 0, rejectedByCode: {} };
      assertRun(await state.scan(feed, 0), {
        code: "removal_limit_exceeded",
        pagesRead: 2,
        wouldRemove: 1,
        maxRemovals: 0,
        listingsRemoved: 0,
        counts,
      });
      assertRun(failed, { code: "http_error", pagesRead: 0 });
      assertRun(await state.lastRun(), { kind: "scan", counts });
      const { feed: [stored] } = await state.incrementalState();
      assert.deepEqual(stored.display_blocks, notices.approvedFeedBlocks);
      const listings = await state.listings();
      assert.deepEqual(
        listings.map(({ facts }) => facts?.price),
        [100, 100, 225],
      );
      for (const { facts } of listings) {
        assert.deepEqual(facts?.display_blocks, notices.approvedListingBlocks);
        assert.deepEqual(facts?.page_blocks, notices.approvedPageBlocks);
      }
    },
  );

  await t.test(
    "retrying a scan after a lost startup commit acknowledgment changes no rows",
    async (t) => {
      const state = await setup(t, "lost_startup_commit");
      const notices = {
        ...disclosures,
        approvedListingBlocks: [
          { ...disclosures.approvedListingBlocks[0], text: "Updated notice" },
        ],
      };
      const feed = await standIn(t, () => ({ status: 503 }));
      const query = writer.query.bind(writer);
      const fault = t.mock.method(
        writer,
        "query",
        async (sql: string, values: unknown[] = []) => {
          const result = await query(sql, values);
          if (sql === "COMMIT")
            throw new Error("Synthetic lost acknowledgment");
          return result;
        },
      );
      async function noticeVersions() {
        const { rows } = await db.query(
          `SELECT id, xmin::text AS version FROM idx.feeds WHERE id = $1
          UNION ALL
          SELECT l.id, l.xmin::text FROM idx.listings l
          JOIN idx.source_mappings m ON m.listing_id = l.id
          WHERE m.feed_id = $1 ORDER BY id`,
          [state.feedId],
        );
        return rows;
      }

      const before = await noticeVersions();
      try {
        assertRun(await state.scan(feed, undefined, writer, notices), {
          code: "write_failed",
          pagesRead: 0,
        });
      } finally {
        fault.mock.restore();
      }
      assert.equal(feed.calls.length, 0);
      const checkpoint = await state.checkpoint();
      assert.equal(checkpoint.active, true);
      const applied = await noticeVersions();
      assert.equal(applied.length, 4);
      assert.notDeepEqual(applied, before);

      assertRun(await state.scan(feed, undefined, writer, notices), {
        code: "http_error",
        pagesRead: 0,
      });
      assert.equal(feed.calls.length, 1);
      assert.deepEqual(await state.checkpoint(), checkpoint);
      assert.deepEqual(await noticeVersions(), applied);
    },
  );

  await t.test(
    "a missing listing returns under the same public ID only at a newer revision",
    async (t) => {
      const state = await setup(t, "restore", [first, second]);
      const [before] = await state.listings();
      const feed = await standIn(t, () => page([second]));
      assertRun(await state.scan(feed, 1), {
        ...complete,
        pagesRead: 1,
        recordsSeen: 1,
        listingsRemoved: 1,
      });
      const [removed] = await state.listings();
      assert.deepEqual(removed, { ...before, facts: null });
      await state.poll([first]);
      assert.deepEqual((await state.listings())[0], removed);
      await state.poll([record("first", 2, "225.00")]);
      const [restored] = await state.listings();
      assert.equal(restored.id, before.id);
      assert.equal(restored.facts?.price, 225);
      assert.equal(restored.revision, revision(2));
    },
  );
});
