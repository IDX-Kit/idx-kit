import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pg from "pg";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { ResoConnector } from "@idx-kit/engine/src/connectors/reso.ts";
import { readFeedCheckpoint } from "@idx-kit/engine/src/db/feed-sync-positions.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { syncFullScan } from "@idx-kit/engine/src/sync/full-scan.ts";
import { syncIncrementally } from "@idx-kit/engine/src/sync/incremental.ts";
import { validateResponse } from "../api/contract.ts";
import { fixtureDisclosures } from "../api/listing-page.ts";
import { keyCommand, startEngine } from "../api/runtime.ts";
import { connectWriter, feedToken, page, standIn } from "./feed.ts";
import {
  heavyRecords,
  initialRevision,
  sourceKey,
} from "./stand-in-records.ts";

const volume = 100_000;
const pageSize = 200;
const pages = volume / pageSize;
const midpoint = pages / 2;
const changed = 50;
const editedRevision = "2026-11-03T00:00:00.000002Z";
const editedPrice = "900000";
const initialRefresh = "2000-01-01T00:00:00Z";
const initialExpiry = "2000-01-01T12:00:00Z";
const feedId = "feed_sync_volume";
const siteId = "site_sync_volume";
const search = "/api/v1/listings";

const price = (n: number) => String(350_000 + (n % 5000) * 100);
const cursor = (index: number) => `?cursor=${index}`;

function assertStatements(
  offsets: number[],
  total: number,
  pageCount: number,
  setup: number,
  completion: number,
  finalPageExtra: number,
) {
  assert.equal(offsets.length, pageCount + Number(finalPageExtra === 0));
  assert.equal(offsets[0], setup, "statements before the first fetch");
  const bounds = [...offsets, total - completion];
  for (let index = 0; index < pageCount; index++) {
    const expected = index === pageCount - 1 ? 7 + finalPageExtra : 7;
    assert.equal(
      bounds[index + 1] - bounds[index],
      expected,
      `SQL statements on page ${index + 1} of this invocation`,
    );
  }
  const pageStatements = pageCount * 7 + finalPageExtra;
  assert.equal(total, setup + pageStatements + completion);
}

function checkPageReads(reads: number[]) {
  assert.equal(reads.length, pages, "one row count per page");
  const final = reads.pop()!;
  const min = Math.min(...reads);
  const max = Math.max(...reads);
  const summary = `${min}–${max} rows read per intermediate page, ${final} on the final page`;
  assert.ok(min > 0 && max <= 32 * pageSize && final >= volume, summary);
  return summary;
}

test(
  "first load and repair of 100,000 listings",
  { timeout: 930_000 },
  async (t) => {
    assert.ok(process.env.DATABASE_URL);
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    t.after(() => db.end());
    const writer = await connectWriter(t);
    // The page counters only see reads made by this connection's own process.
    await writer.query("SET max_parallel_workers_per_gather = 0");
    const fixtures = await new FixtureConnector().read();
    const [fixtureFeed] = fixtures.feeds;
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
      sites: [{ id: siteId, feedIds: [feedId] }],
    });

    const directory = await mkdtemp(`${tmpdir()}/idx-sync-volume-`);
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { secret } = await keyCommand(
      directory,
      "create",
      siteId,
      "listings:read",
    );
    const engine = await startEngine();
    t.after(() => engine.stop());
    const fetchApi = (path: string) =>
      fetch(`http://127.0.0.1:8787${path}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
    async function checkResponse(
      response: Response,
      path: string,
      status: number,
    ) {
      const body = await response.json();
      assert.equal(response.status, status, path);
      validateResponse(path, response, body);
      return body;
    }
    const detail = async (id: string, status = 200) =>
      checkResponse(
        await fetchApi(`${search}/${id}`),
        `${search}/{listingId}`,
        status,
      );
    async function assertExpired(response: Response) {
      const body = await checkResponse(response, search, 503);
      assert.equal(body.code, "feed_expired");
    }

    async function listings() {
      const { rows } = await db.query<{
        key: string;
        id: string;
        price: string | null;
        revision: string;
        facts: string | null;
      }>(
        `SELECT m.source_key AS key, m.listing_id AS id, l.price,
        to_char(m.source_revision AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision,
        md5(to_jsonb(l)::text) AS facts
      FROM idx.source_mappings m
      LEFT JOIN idx.listings l ON l.id = m.listing_id AND l.entire_listing_display
      WHERE m.feed_id = $1 ORDER BY m.source_key`,
        [feedId],
      );
      return rows;
    }

    async function databaseSize() {
      const { rows } = await db.query<{ bytes: string }>(
        "SELECT pg_database_size(current_database()) AS bytes",
      );
      return rows[0].bytes;
    }

    let statements = 0;
    const pageReads: number[] = [];
    const finalTimes: number[] = [];
    let pageIndex: number | undefined;
    let startReads = 0;
    const query = writer.query.bind(writer);
    async function readRows() {
      // List index IDs from the view and read their transaction-local counters.
      const { rows } = await query<{ count: string }>(
        `SELECT
          (SELECT COALESCE(sum(seq_tup_read), 0)
           FROM pg_stat_xact_user_tables WHERE schemaname = 'idx') +
          (SELECT COALESCE(sum(pg_stat_get_xact_tuples_returned(indexrelid)), 0)
           FROM pg_stat_user_indexes WHERE schemaname = 'idx') AS count`,
      );
      return Number(rows[0].count);
    }
    t.mock.method(
      writer,
      "query",
      async (sql: string, values: unknown[] = []) => {
        statements += 1;
        if (sql === "COMMIT" && pageIndex !== undefined) {
          pageReads.push((await readRows()) - startReads);
          pageIndex = undefined;
        }
        const started = performance.now();
        const result = await query(sql, values);
        if (pageIndex === pages - 1)
          finalTimes.push(performance.now() - started);
        if (sql === "BEGIN" && pageIndex !== undefined)
          startReads = await readRows();
        return result;
      },
    );

    const offsets: number[] = [];
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let interrupt = true;
    let scanning = false;
    const source = fixtures.listings[0].source;
    const feed = await standIn(t, async (url) => {
      const index = Number(url.searchParams.get("cursor"));
      offsets.push(statements);
      if (interrupt && index === midpoint) {
        arrive();
        await released;
        return { status: 503 };
      }
      pageIndex = index;
      const start = index * pageSize + (scanning ? changed : 0);
      const size = Math.min(pageSize, volume - start);
      const records = Array.from({ length: size }, (_, offset) => {
        const n = start + offset + 1;
        const edited = scanning && n > volume - changed;
        return {
          ...source,
          ListingKey: sourceKey(n),
          ModificationTimestamp: edited ? editedRevision : initialRevision,
          ListPrice: edited ? editedPrice : price(n),
        };
      });
      return page(records, index + 1 < pages ? cursor(index + 1) : undefined);
    });
    const options = {
      feedId,
      synthetic: true,
      connector: feed.connector,
      disclosures: fixtureDisclosures(fixtures, fixtureFeed.id),
    };

    let started = performance.now();
    const firstRun = syncIncrementally(writer, options);
    let unfinished: Response;
    try {
      await Promise.race([arrived, firstRun]);
      unfinished = await fetchApi(search);
    } finally {
      release();
    }
    const stopped = await firstRun;
    const firstMs = performance.now() - started;
    assert.deepEqual(stopped, {
      code: "http_error",
      nextStep: { kind: "retry" },
      counts: {
        accepted: midpoint * pageSize,
        rejected: 0,
        rejectedByCode: {},
      },
    });
    await assertExpired(unfinished);
    assertStatements(offsets.splice(0), statements, midpoint, 1, 1, 0);
    const firstStatements = statements;
    const saved = await readFeedCheckpoint(db, feedId);
    assert.equal(saved.version, BigInt(midpoint));
    assert.equal(saved.position.pendingMark, initialRevision);
    assert.equal(saved.position.completedMark, null);
    assert.equal(new URL(saved.position.nextLink!).search, cursor(midpoint));
    const partial = await listings();
    assert.equal(partial.length, midpoint * pageSize);
    await assertExpired(await fetchApi(search));
    assert.equal((await detail(partial[0].id, 503)).code, "feed_expired");

    interrupt = false;
    statements = 0;
    started = performance.now();
    const resumed = await syncIncrementally(writer, options);
    const loadMs = firstMs + performance.now() - started;
    assert.deepEqual(resumed, {
      code: "complete",
      counts: { accepted: volume, rejected: 0, rejectedByCode: {} },
    });
    const loadBytes = await databaseSize();
    assert.equal(feed.calls[midpoint + 1].query, cursor(midpoint));
    // The final incremental page renews the feed window after recomputing.
    const loadRecomputeMs = finalTimes.splice(0).at(-3)!;
    const loadReads = checkPageReads(pageReads.splice(0));
    assertStatements(offsets.splice(0), statements, pages - midpoint, 1, 0, 3);
    const loadStatements = firstStatements + statements;
    assert.equal(loadStatements, pages * 7 + 6);
    assert.deepEqual(await readFeedCheckpoint(db, feedId), {
      version: BigInt(pages),
      position: {
        completedMark: initialRevision,
        nextLink: null,
        pendingMark: null,
        recordState: "empty",
      },
    });
    const loaded = await listings();
    assert.equal(loaded.length, volume);
    for (const [index, row] of loaded.entries()) {
      assert.equal(row.key, sourceKey(index + 1));
      assert.ok(row.facts, `public listing ${index + 1}`);
      assert.equal(row.price, price(index + 1));
      assert.equal(row.revision, initialRevision);
      if (index < partial.length) assert.equal(row.id, partial[index].id);
    }
    const fresh = await checkResponse(await fetchApi(search), search, 200);
    assert.equal(fresh.data.length, 20);
    const publicIds = new Set(loaded.map(({ id }) => id));
    assert.ok(fresh.data.every(({ id }: { id: string }) => publicIds.has(id)));
    assert.equal((await detail(fresh.data[0].id)).data.id, fresh.data[0].id);

    scanning = true;
    statements = 0;
    started = performance.now();
    const scan = await syncFullScan(writer, {
      ...options,
      removeMissing: true,
      maxRemovals: 100,
    });
    const scanMs = performance.now() - started;
    const scanBytes = await databaseSize();
    const scanRecomputeMs = finalTimes.at(-1)!;
    const scanReads = checkPageReads(pageReads);
    t.diagnostic(
      `First load: ${(loadMs / 1000).toFixed(2)}s, ${pages} pages, ${loadStatements} SQL statements, ${loadBytes} database bytes, ${loadRecomputeMs.toFixed(2)} ms to recompute freshness, ${loadReads}. ` +
        `Full scan: ${(scanMs / 1000).toFixed(2)}s, ${scan.pagesRead} pages, ${statements} SQL statements, ${scanBytes} database bytes, ${scanRecomputeMs.toFixed(2)} ms to recompute freshness, ${scanReads}.`,
    );
    assert.ok(loadMs + scanMs <= 900_000, "first load and scan exceeded 900s");
    assert.deepEqual(scan, {
      code: "complete",
      nextStep: { kind: "none" },
      pagesRead: pages,
      recordsSeen: volume - changed,
      listingsRemoved: changed,
      counts: { accepted: volume - changed, rejected: 0, rejectedByCode: {} },
    });
    assertStatements(offsets, statements, pages, 5, 0, 2);
    const repaired = await listings();
    assert.equal(repaired.length, volume);
    for (const [index, row] of repaired.entries()) {
      const before = loaded[index];
      assert.equal(row.key, before.key);
      assert.equal(row.id, before.id);
      if (index < changed) {
        assert.equal(row.facts, null, `withdrawn listing ${index + 1}`);
        assert.equal(row.revision, before.revision);
      } else if (index >= volume - changed) {
        assert.ok(row.facts, `repaired listing ${index + 1}`);
        assert.equal(row.price, editedPrice);
        assert.equal(row.revision, editedRevision);
      } else {
        assert.equal(row.facts, before.facts, `unchanged listing ${index + 1}`);
        assert.equal(row.revision, before.revision);
      }
    }
    assert.equal((await detail(loaded[0].id, 404)).code, "not_found");
    assert.equal(
      (await detail(loaded.at(-1)!.id)).data.price.amount,
      editedPrice,
    );

    const empty = await checkResponse(
      await fetchApi(`${search}?city=No%20Such%20Synthetic%20City`),
      search,
      200,
    );
    assert.deepEqual(empty.data, []);
    assert.deepEqual(empty.meta.page, {
      limit: 20,
      nextCursor: null,
      hasMore: false,
    });
    assert.equal(empty.display.blocks[0].id, fixtureFeed.blocks[0].id);
    await db.query(
      "UPDATE idx.feeds SET refreshed_at=$2, expires_at=$3 WHERE id=$1",
      [feedId, initialRefresh, initialExpiry],
    );
    await assertExpired(await fetchApi(search));
    assert.equal((await detail(loaded.at(-1)!.id, 503)).code, "feed_expired");
  },
);

test(
  "measure incremental page cost with heavy synthetic records",
  { timeout: 60_000 },
  async (t) => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    t.after(() => db.end());
    const writer = await connectWriter(t);
    const fixtures = await new FixtureConnector().read();
    const [fixtureFeed] = fixtures.feeds;
    const disclosures = fixtureDisclosures(fixtures, fixtureFeed.id);
    for (const size of [200, 100, 50, 25]) {
      const feedId = `feed_sync_cost_${size}`;
      await seed(db, {
        feeds: [{ ...fixtureFeed, id: feedId }],
        listings: [],
        sites: [],
      });
      const generated = heavyRecords(fixtures.listings[0].source, size * 20);
      const records = generated.slice(0, generated.length);
      const fixedRecords = Object.assign(records, {
        revision: initialRevision,
      });
      const feed = await standIn(t, () => fixedRecords);
      const connector = new ResoConnector(
        feed.propertyUrl,
        feedToken,
        undefined,
        size,
      );
      const start = performance.now();
      const cpuStart = process.cpuUsage();
      const result = await syncIncrementally(writer, {
        feedId,
        synthetic: true,
        connector,
        disclosures,
      });
      const { user, system } = process.cpuUsage(cpuStart);
      const elapsed = performance.now() - start;
      assert.equal(result.code, "complete");
      const count = feed.calls.length;
      const cpuPerPage = (user + system) / 1000 / count;
      t.diagnostic(
        `Page size ${size}, ${count} pages: ${cpuPerPage.toFixed(2)} ms CPU/page, ${(elapsed / count).toFixed(2)} ms elapsed/page`,
      );
    }
  },
);
