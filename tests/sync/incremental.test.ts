import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pg from "pg";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { readFeedCheckpoint } from "@idx-kit/engine/src/db/feed-sync-positions.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { syncIncrementally } from "@idx-kit/engine/src/sync/incremental.ts";
import { fixtureDisclosures } from "../api/listing-page.ts";
import { listenOnLoopback } from "../api/loopback-server.ts";
import { page, propertyPath, standIn } from "./feed.ts";

const firstMark = "2026-11-03T00:00:00.000001Z";
const secondMark = "2026-11-03T00:00:00.000002Z";
const thirdMark = "2026-11-03T00:00:00.000003Z";
const initialRefresh = "2000-01-01T00:00:00Z";
const initialExpiry = "2000-01-01T12:00:00Z";

const filter = (mark: string) =>
  `?${new URLSearchParams({ $filter: `ModificationTimestamp ge ${mark}` })}`;

async function connectWriter(t: TestContext) {
  assert.ok(process.env.LISTING_WRITER_DATABASE_URL);
  const client = new pg.Client({
    connectionString: process.env.LISTING_WRITER_DATABASE_URL,
  });
  await client.connect();
  t.after(() => client.end());
  return client;
}

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
      db.query("UPDATE idx.feeds SET refreshed_at=$2, expires_at=$3 WHERE id=$1", [
        feedId,
        initialRefresh,
        initialExpiry,
      ]);
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
      await db.query("DELETE FROM idx.source_mappings WHERE feed_id=$1", [feedId]);
      await db.query("DELETE FROM idx.feeds WHERE id=$1", [feedId]);
    });
    const freshness = async () => {
      const { rows } = await db.query<{
        refreshed_at: Date;
        expires_at: Date;
      }>("SELECT refreshed_at, expires_at FROM idx.feeds WHERE id=$1", [feedId]);
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
      (await listings()).map(({ key, price, revision }) => ({ key, price, revision }));
    return {
      run: ({ connector }: StandIn, client = writer) =>
        syncIncrementally(client, { feedId, synthetic: true, connector, disclosures }),
      checkpoint: () => readFeedCheckpoint(db, feedId),
      setOldFreshness,
      freshness,
      listings,
      facts,
    };
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

  await t.test("finishes unordered pages and preserves the greatest source time", async (t) => {
    const state = await setup(t, "complete");
    const feed = await standIn(t, (_url, number) => {
      if (number === 1) return page([third], `${propertyPath}/next?cursor=2`);
      if (number === 2) return page([first], "?cursor=3");
      return page([second]);
    });
    assert.deepEqual(await state.run(feed), { code: "complete" });
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
    assert.deepEqual(
      await state.facts(),
      [first, second, third].map((record) => ({
        key: record.ListingKey,
        price: record.ListPrice,
        revision: record.ModificationTimestamp,
      })),
    );
  });

  await t.test("a failed middle fetch resumes with the same facts as an uninterrupted run", async (t) => {
    const state = await setup(t, "resume");
    const uninterrupted = await setup(t, "uninterrupted");
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
    assert.deepEqual(await state.run(feed), { code: "http_error" });
    assert.deepEqual(await state.freshness(), oldFreshness);
    const saved = await state.checkpoint();
    assert.equal(saved.version, 1n);
    assert.equal(saved.position.completedMark, null);
    assert.equal(saved.position.pendingMark, thirdMark);
    assert.equal(new URL(saved.position.nextLink!).search, "?cursor=2");
    const [before] = await state.listings();
    assert.equal(before.key, third.ListingKey);

    fail = false;
    assert.deepEqual(await state.run(feed), { code: "complete" });
    assert.deepEqual(feed.calls.map(({ query }) => query), [
      "", "?cursor=2", "?cursor=2", "?cursor=3",
    ]);
    assert.deepEqual(await uninterrupted.run(feed), { code: "complete" });
    assert.deepEqual(await state.facts(), await uninterrupted.facts());
    assert.equal((await state.listings()).find(({ key }) => key === before.key)?.id, before.id);
    assert.deepEqual((await state.checkpoint()).position, complete(thirdMark));
    await assertFresh(state);
  });

  await t.test("a committed page with a lost acknowledgement resumes with stable IDs", async (t) => {
    const state = await setup(t, "lost_ack");
    const feed = await standIn(t, (url) =>
      url.search ? page([first, second]) : page([first], "?cursor=2"),
    );
    const oldFreshness = await state.freshness();
    const query = writer.query.bind(writer);
    const fault = t.mock.method(writer, "query", async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (sql === "COMMIT") throw new Error("Synthetic lost acknowledgement");
      return result;
    });
    try {
      assert.deepEqual(await state.run(feed), { code: "write_failed" });
    } finally {
      fault.mock.restore();
    }
    assert.deepEqual(await state.freshness(), oldFreshness);
    const [before] = await state.listings();
    assert.equal(before.key, first.ListingKey);
    assert.equal((await state.checkpoint()).version, 1n);

    const peer = await connectWriter(t);
    assert.deepEqual(await state.run(feed, peer), { code: "complete" });
    assert.deepEqual(feed.calls.map(({ query }) => query), ["", "?cursor=2"]);
    const after = await state.listings();
    assert.deepEqual(after[0], before);
    assert.deepEqual(after.map(({ key }) => key), [first.ListingKey, second.ListingKey]);
    assert.deepEqual((await state.checkpoint()).position, complete(secondMark));
  });

  await t.test("a page and checkpoint both roll back before commit", async (t) => {
    const state = await setup(t, "rollback");
    const feed = await standIn(t, () => page([first]));
    const oldFreshness = await state.freshness();
    const query = writer.query.bind(writer);
    const fault = t.mock.method(writer, "query", async (sql: string, values?: unknown[]) => {
      if (sql === "COMMIT") throw new Error("Synthetic failure before commit");
      return query(sql, values);
    });
    try {
      assert.deepEqual(await state.run(feed), { code: "write_failed" });
    } finally {
      fault.mock.restore();
    }
    assert.equal((await state.checkpoint()).version, 0n);
    assert.deepEqual(await state.listings(), []);
    assert.deepEqual(await state.freshness(), oldFreshness);
    assert.deepEqual(await state.run(feed), { code: "complete" });
    assert.deepEqual(feed.calls.map(({ query }) => query), ["", ""]);
  });

  await t.test("the inclusive filter replays ties and finds new records at the completed mark", async (t) => {
    const state = await setup(t, "ties");
    const tied = record("tied", firstMark);
    const feed = await standIn(t, (url, number) => {
      if (number === 1) return page([first]);
      const expression = url.searchParams.get("$filter");
      return page(expression === `ModificationTimestamp ge ${firstMark}` ? [tied, first] : []);
    });
    assert.deepEqual(await state.run(feed), { code: "complete" });
    const [before] = await state.listings();
    assert.deepEqual(await state.run(feed), { code: "complete" });
    assert.deepEqual(feed.calls.map(({ query }) => query), ["", filter(firstMark)]);
    const after = await state.listings();
    assert.deepEqual(after[0], before);
    assert.deepEqual(after.map(({ key }) => key), [first.ListingKey, tied.ListingKey]);
    assert.deepEqual((await state.checkpoint()).position, complete(firstMark));
  });

  for (const status of [400, 410]) {
    await t.test(`${status} on a continuation clears only in-progress state and stops`, async (t) => {
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
      assert.deepEqual(await state.run(feed), { code: "continuation_rejected" });
      assert.deepEqual(await state.checkpoint(), {
        version: 3n,
        position: complete(firstMark),
      });
      assert.deepEqual(await state.freshness(), freshness);
      const applied = await state.listings();
      assert.deepEqual(applied.map(({ key }) => key), [first.ListingKey, third.ListingKey]);
      assert.deepEqual(await state.run(feed), { code: "complete" });
      assert.deepEqual(feed.calls.map(({ query }) => query), [
        "", filter(firstMark), "?cursor=expired", filter(firstMark), "?cursor=fresh",
      ]);
      const final = await state.listings();
      assert.equal(final.length, 3);
      assert.deepEqual([final[0], final[2]], applied);
      assert.deepEqual((await state.checkpoint()).position, complete(thirdMark));
    });
  }

  await t.test("a runner with a stale position stops without applying its page", async (t) => {
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
    assert.deepEqual(await state.run(feed), { code: "http_error" });
    const losing = state.run(feed, peer);
    try {
      await Promise.race([arrived, losing]);
      assert.deepEqual(await state.run(feed), { code: "complete" });
    } finally {
      release();
    }
    const freshness = await state.freshness();
    assert.deepEqual(await losing, { code: "position_changed" });
    assert.deepEqual(await state.checkpoint(), {
      version: 3n,
      position: complete(thirdMark),
    });
    assert.deepEqual(await state.freshness(), freshness);
    assert.deepEqual(feed.calls.map(({ query }) => query), [
      "", "?cursor=2", "?cursor=2", "?cursor=2", "?cursor=3",
    ]);
    assert.deepEqual((await state.listings()).map(({ key }) => key), [
      first.ListingKey, second.ListingKey, third.ListingKey,
    ]);
  });

  await t.test("a complete empty poll renews freshness and keeps the completed mark", async (t) => {
    const state = await setup(t, "empty");
    const feed = await standIn(t, (_url, number) => page(number === 1 ? [first] : []));
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
  });

  await t.test("outside continuations and HTTP redirects never receive the bearer token", async (t) => {
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
      assert.deepEqual(await state.run(feed), { code: "invalid_link" }, link);
    }
    assert.deepEqual(await state.run(feed), { code: "http_error" });
    assert.deepEqual(outsideRequests, []);
    assert.deepEqual(feed.calls, Array(4).fill({
      path: propertyPath, query: "", authorized: true,
    }));
    assert.equal((await state.checkpoint()).version, 0n);
    assert.deepEqual(await state.listings(), []);
    assert.deepEqual(await state.freshness(), freshness);
  });

  await t.test("fetch failures are redacted and keep the saved page available to retry", async (t) => {
    const state = await setup(t, "fetch_failures");
    const feed = await standIn(t, (_url, number) => {
      if (number === 1) return page([first], "?cursor=retry-marker");
      if (number === 2) return { status: 429 };
      if (number === 3) return "disconnect";
      if (number === 4) return "invalid_json";
      if (number === 5) return page([], "");
      if (number === 6) return "stall";
      return page([second]);
    }, 1_000);
    const freshness = await state.freshness();
    assert.deepEqual(await state.run(feed), { code: "http_error" });
    const checkpoint = await state.checkpoint();
    const before = await state.listings();
    for (const code of ["fetch_failed", "invalid_page", "invalid_page", "fetch_timeout"]) {
      assert.deepEqual(await state.run(feed), { code });
      assert.deepEqual(await state.checkpoint(), checkpoint);
      assert.deepEqual(await state.listings(), before);
      assert.deepEqual(await state.freshness(), freshness);
    }
    assert.deepEqual(await state.run(feed), { code: "complete" });
    assert.deepEqual(feed.calls.map(({ query }) => query), ["", ...Array(6).fill("?cursor=retry-marker")]);
  });

  await t.test("an unreadable listing still reaches the writer and withdraws its prior facts", async (t) => {
    const state = await setup(t, "unreadable");
    const feed = await standIn(t, (_url, number) =>
      number === 1
        ? page([first])
        : page([null, record("first", secondMark, "invalid synthetic price")]),
    );
    assert.deepEqual(await state.run(feed), { code: "complete" });
    const [before] = await state.listings();
    assert.equal(before.price, first.ListPrice);
    assert.deepEqual(await state.run(feed), { code: "complete" });
    assert.deepEqual(await state.listings(), [
      { key: before.key, id: before.id, price: null, revision: null },
    ]);
    assert.deepEqual((await state.checkpoint()).position, complete(secondMark));
  });
});
