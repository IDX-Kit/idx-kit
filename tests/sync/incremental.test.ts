import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import pg from "pg";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { ResoConnector } from "@idx-kit/engine/src/connectors/reso.ts";
import { readFeedCheckpoint } from "@idx-kit/engine/src/db/feed-sync-positions.ts";
import type { FeedNextStep } from "@idx-kit/engine/src/db/feed-sync-outcomes.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { syncIncrementally } from "@idx-kit/engine/src/sync/incremental.ts";
import { fixtureDisclosures } from "../api/listing-page.ts";
import { listenOnLoopback } from "../api/loopback-server.ts";
import {
  connectWriter,
  countWriterStatements,
  page,
  propertyPath,
  readOldestIngest,
  standIn,
} from "./feed.ts";

const firstMark = "2026-11-03T00:00:00.000001Z";
const secondMark = "2026-11-03T00:00:00.000002Z";
const thirdMark = "2026-11-03T00:00:00.000003Z";
const initialRefresh = "2000-01-01T00:00:00Z";
const initialExpiry = "2000-01-01T12:00:00Z";
const retry = { kind: "retry" } as const;
const stop = { kind: "stop" } as const;
const retryHttpError = { code: "http_error", nextStep: retry };
const stopHttpError = { code: "http_error", nextStep: stop };
const writeFailed = { code: "write_failed", nextStep: retry };

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

  async function setup(t: TestContext, name: string) {
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
      sites: [],
    });
    t.after(async () => {
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
      run: ({ connector }: Pick<StandIn, "connector">, client = writer) =>
        syncIncrementally(client, {
          feedId,
          synthetic: true,
          connector,
          disclosures,
        }),
      checkpoint: () => readFeedCheckpoint(db, feedId),
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

  const complete = (completedMark: string) => ({
    completedMark,
    nextLink: null,
    pendingMark: null,
  });

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
      assert.deepEqual(await state.run(feed), { code: "complete" });
      assert.deepEqual([...offsets, statements()], [1, 8, 15, 25]);
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
        now: Date.parse("1999-01-01T00:00:00Z"),
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
      assert.deepEqual(await state.run(feed), retryHttpError);
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
      assert.deepEqual(await state.run(feed), { code: "complete" });
      assert.deepEqual(
        feed.calls.map(({ query }) => query),
        ["", "?cursor=2", "?cursor=2", "?cursor=3"],
      );
      assert.deepEqual(await uninterrupted.run(feed), { code: "complete" });
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
      assert.deepEqual(await state.run(initial), { code: "complete" });
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
      assert.deepEqual(await state.run(feed), retryHttpError);
      const partial = await state.oldestIngest();
      assert.equal(partial.stored, before.stored);
      assert.ok(partial.actual && partial.actual !== partial.stored);
      assert.equal(partial.conservative, true);

      fail = false;
      assert.deepEqual(await state.run(feed), { code: "complete" });
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
        assert.deepEqual(await state.run(feed), writeFailed);
      } finally {
        fault.mock.restore();
      }
      assert.deepEqual(await state.freshness(), oldFreshness);
      const [before] = await state.listings();
      assert.equal(before.key, first.ListingKey);
      assert.equal((await state.checkpoint()).version, 1n);

      const peer = await connectWriter(t);
      assert.deepEqual(await state.run(feed, peer), { code: "complete" });
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
        assert.deepEqual(await state.run(feed), writeFailed);
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
      assert.deepEqual(await state.listings(), []);
      assert.deepEqual(await state.freshness(), oldFreshness);
      assert.deepEqual(await state.run(feed), { code: "complete" });
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
      assert.deepEqual(await state.run(feed), { code: "complete" });
      const [before] = await state.listings();
      assert.deepEqual(await state.run(feed), { code: "complete" });
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
    "older pages keep both marks from moving backward",
    async (t) => {
      const state = await setup(t, "older_pages");
      const feed = await standIn(t, (_url, number) => {
        if (number === 1) return page([third]);
        if (number === 2) return page([first], "?cursor=older");
        if (number === 3) return { status: 503 };
        return page([second]);
      });
      assert.deepEqual(await state.run(feed), { code: "complete" });
      assert.deepEqual(await state.run(feed), retryHttpError);
      const { position } = await state.checkpoint();
      assert.equal(position.completedMark, thirdMark);
      assert.equal(position.pendingMark, thirdMark);
      assert.deepEqual(await state.run(feed), { code: "complete" });
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
          if (number === 2) return page([third], "?cursor=expired");
          if (number === 3) return { status };
          if (number === 4) return page([third, first], "?cursor=fresh");
          return page([second]);
        });
        assert.deepEqual(await state.run(feed), { code: "complete" });
        const freshness = await state.freshness();
        assert.deepEqual(await state.run(feed), {
          code: "continuation_rejected",
          nextStep: retry,
        });
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
        assert.deepEqual(await state.run(feed), { code: "complete" });
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
      assert.deepEqual(await state.run(feed), retryHttpError);
      const losing = state.run(feed, peer);
      let winningOutcome;
      try {
        await Promise.race([arrived, losing]);
        assert.deepEqual(await state.run(feed), { code: "complete" });
        winningOutcome = await state.outcome();
      } finally {
        release();
      }
      const freshness = await state.freshness();
      assert.deepEqual(await losing, {
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
        assert.deepEqual(await state.run(winner, peer), { code: "complete" });
        winningOutcome = await state.outcome();
        return { status: 401 };
      });
      assert.deepEqual(await state.run(stale), stopHttpError);
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
            assert.deepEqual(await state.run(feed, peer), stopHttpError);
          }
          return result;
        },
      );
      assert.deepEqual(await state.run(feed), { code: "complete" });
      await assertOutcome(state, {
        code: "http_error",
        status: 401,
        step: "stop",
        version: 1,
      });
    },
  );

  await t.test(
    "a writer without outcome grants still returns complete and stop",
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
        assert.deepEqual(await state.run(feed), {
          code: "complete",
          outcomeSaved: false,
        });
        assert.deepEqual(await state.checkpoint(), {
          version: 1n,
          position: complete(firstMark),
        });
        await assertFresh(state);
        assert.deepEqual(await state.run(feed), {
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
      assert.deepEqual(await state.run(feed), { code: "complete" });
      const before = await state.listings();
      await state.setOldFreshness();
      assert.deepEqual(await state.run(feed), { code: "complete" });
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
        assert.deepEqual(
          await state.run(feed),
          { code: "invalid_link", nextStep: stop },
          link,
        );
      }
      assert.deepEqual(await state.run(feed), stopHttpError);
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
        assert.deepEqual(await state.run({ connector: remote }), {
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
      assert.deepEqual(await state.run(feed), retryHttpError);
      const checkpoint = await state.checkpoint();
      const listings = await state.listings();
      const freshness = await state.freshness();
      for (const requestCount of [3, 4]) {
        assert.deepEqual(await state.run(feed), {
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
        assert.deepEqual(await state.run(feed), {
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
      assert.deepEqual(await state.run(feed), { code: "complete" });
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
      assert.deepEqual(await state.run(feed), retryHttpError);
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
        assert.deepEqual(await state.run(feed), { code, nextStep: retry });
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
      assert.deepEqual(await state.run(feed), { code: "complete" });
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
      assert.deepEqual(await state.run(feed), { code: "complete" });
      const [before] = await state.listings();
      assert.equal(before.price, first.ListPrice);
      assert.deepEqual(await state.run(feed), { code: "complete" });
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
