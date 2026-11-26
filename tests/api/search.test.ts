import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pg from "pg";
import type { DisplayBlock, Listing, SearchResponse } from "@idx-kit/client";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { searchListings } from "@idx-kit/engine/src/db/search.ts";
import { listingSelect } from "@idx-kit/engine/src/db/read.ts";
import {
  searchQuery,
  searchSchema,
  CURSOR_MAX_BYTES,
} from "@idx-kit/engine/src/domain/search-query.ts";
import type { SearchQuery } from "@idx-kit/engine/src/domain/search-query.ts";
import type { FixtureRecord } from "@idx-kit/engine/src/domain/normalize.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { validateResponse } from "./contract.ts";
import { keyCommand, preserveKeys, startEngine } from "./runtime.ts";
import { explainSearch, flatten, summarizeSearch } from "./search-plan.ts";

test(
  "real HTTP search and live continuation acceptance",
  { timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(`${tmpdir()}/idx-search-`);
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const fixtures = await new FixtureConnector().read();
    const licensedCount = fixtures.listings.filter(
      (item) =>
        item.feedId === "feed_demo_primary" &&
        item.source.InternetEntireListingDisplayYN,
    ).length;
    const restoreKeys = await preserveKeys(db);
    t.after(async () => {
      try {
        await restoreKeys();
      } finally {
        try {
          await db.end();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    });
    const key = await keyCommand(
      directory,
      "create",
      "site_demo_primary",
      "listings:read",
    );
    const other = await keyCommand(
      directory,
      "create",
      "site_demo_other",
      "listings:read",
      "other",
    );
    const limited = await keyCommand(
      directory,
      "create",
      "site_demo_primary",
      "inquiries:read",
      "limited",
    );
    const engine = await startEngine();
    t.after(() => engine.stop());
    const clearExtra = async () => {
      await db.query(
        "DELETE FROM idx.source_mappings WHERE listing_id LIKE 'lst_search_%'",
      );
      await db.query("DELETE FROM idx.listings WHERE id LIKE 'lst_search_%'");
    };
    t.afterEach(async () => {
      await clearExtra();
      await seed(db, fixtures);
    });
    const path = "/api/v1/listings";
    const requestIds = new Set<string>();
    const requests: { id: string; status: number; code: string }[] = [];
    async function request(
      query = "",
      status = 200,
      secret: string | null = key.secret,
      init: RequestInit = {},
    ) {
      const headers = new Headers(init.headers);
      if (secret !== null) headers.set("Authorization", `Bearer ${secret}`);
      const response = await fetch(
        `http://127.0.0.1:8787${path}${query ? "?" + query : ""}`,
        { ...init, headers },
      );
      assert.equal(response.status, status, query);
      const text = await response.text();
      const body = init.method === "HEAD" ? undefined : JSON.parse(text);
      validateResponse(path, response, body, init.method === "HEAD");
      const id = response.headers.get("Request-Id")!;
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.ok(!requestIds.has(id));
      requestIds.add(id);
      assert.equal(
        response.headers.get("Cache-Control"),
        status === 200 ? "private, no-store" : "no-store",
      );
      assert.ok(
        !Array.from(response.headers.keys()).some((name) =>
          name.startsWith("access-control-"),
        ),
      );
      if (body && status >= 400) {
        assert.equal(body.status, status);
        assert.equal(body.requestId, id);
      }
      if (status === 200) {
        assert.equal(
          body.meta.page.hasMore,
          body.meta.page.nextCursor !== null,
        );
        assert.ok(body.data.length <= body.meta.page.limit);
        assert.ok(!Object.hasOwn(body.meta.page, "total"));
      }
      requests.push({
        id,
        status,
        code: body?.code ?? (status === 405 ? "method_not_allowed" : "ok"),
      });
      return { body, response, text };
    }
    const ids = (body: SearchResponse): string[] =>
      body.data.map((item: Listing) => item.id);
    async function browse(query: string, initialCursor: string | null = null) {
      const data: Listing[] = [];
      let cursor: string | null = initialCursor;
      do {
        const { body } = await request(
          query + (cursor ? "&after=" + cursor : ""),
        );
        data.push(...body.data);
        cursor = body.meta.page.nextCursor;
        assert.ok(data.length < 100, "Paging must terminate");
      } while (cursor !== null);
      return data;
    }
    await t.test(
      "each filter and AND combinations match synthetic facts; city trims and folds case exactly",
      async () => {
        for (const query of [
          "city=Example%20Springs",
          "city=%20eXaMpLe%20sPrInGs%20",
          "city=Example",
          "minPrice=420000",
          "maxPrice=390000",
          "minBedrooms=3",
          "minBedrooms=0",
          "city=Example%20Springs&minPrice=390000&maxPrice=435000&minBedrooms=3",
        ]) {
          const params = new URLSearchParams(query);
          const expected = fixtures.listings
            .filter(
              (item) =>
                item.feedId === "feed_demo_primary" &&
                item.source.InternetEntireListingDisplayYN,
            )
            .filter(
              ({ source: s }) =>
                (!params.has("city") ||
                  (s.InternetAddressDisplayYN &&
                    s.Address?.city.toLowerCase() ===
                      params.get("city")!.trim().toLowerCase())) &&
                (!params.has("minPrice") ||
                  (s.ListPrice !== null &&
                    Number(s.ListPrice) >= Number(params.get("minPrice")))) &&
                (!params.has("maxPrice") ||
                  (s.ListPrice !== null &&
                    Number(s.ListPrice) <= Number(params.get("maxPrice")))) &&
                (!params.has("minBedrooms") ||
                  (s.BedroomsTotal !== null &&
                    s.BedroomsTotal >= Number(params.get("minBedrooms")))),
            )
            .map((item) => item.publicId)
            .sort();
          assert.deepEqual(
            ids((await request(query + "&limit=50")).body).sort(),
            expected,
          );
        }
      },
    );
    await t.test(
      "city matching folds accented case and preserves accents",
      async () => {
        // Invented city for the existing synthetic listing.
        const city = "Élan Springs";
        const listingId = "lst_demo_0001";
        await db.query(
          "UPDATE idx.listings SET address = jsonb_set(address, '{city}', to_jsonb($1::text)) WHERE id = $2",
          [city, listingId],
        );
        for (const name of [city, " éLAN sPRINGS "]) {
          const query = new URLSearchParams({ city: name });
          const { body } = await request(query.toString());
          assert.deepEqual(ids(body), [listingId]);
        }
        const { body } = await request("city=Elan%20Springs");
        assert.deepEqual(ids(body), []);
      },
    );
    await t.test(
      "USD-only numeric filters preserve exact decimal major units and exclude nulls",
      async () => {
        await db.query(
          "UPDATE idx.listings SET currency='CAD' WHERE id='lst_demo_0001'",
        );
        await db.query(
          "UPDATE idx.listings SET price=425000.000000000000000001 WHERE id='lst_demo_0003'",
        );
        const all = (await request("limit=50")).body;
        assert.equal(
          all.data.find((item: Listing) => item.id === "lst_demo_0001").price
            .currency,
          "CAD",
        );
        const exact = (
          await request(
            "minPrice=425000.000000000000000001&maxPrice=425000.000000000000000001",
          )
        ).body;
        assert.deepEqual(ids(exact), ["lst_demo_0003"]);
        assert.equal(exact.data[0].price.amount, "425000.000000000000000001");
        assert.deepEqual(
          ids((await request("minPrice=425000&maxPrice=425000")).body),
          ["lst_demo_0002"],
        );
        const known = (await request("minPrice=0&minBedrooms=0&limit=50")).body;
        assert.ok(
          known.data.every(
            (item: Listing) =>
              item.price !== null &&
              item.price.currency === "USD" &&
              item.bedrooms !== null,
          ),
        );
        assert.ok(
          !ids(known).includes("lst_demo_0004") &&
            !ids(known).includes("lst_demo_0002"),
        );
      },
    );
    await t.test(
      "ties cross page boundaries by ascending ID for both sorts",
      async () => {
        for (const sort of ["price", "-price"]) {
          const rows = await browse(
            `minPrice=425000&maxPrice=425000&limit=1&sort=${sort}`,
          );
          assert.deepEqual(
            rows.map((item) => item.id),
            ["lst_demo_0001", "lst_demo_0002", "lst_demo_0003"],
          );
        }
      },
    );
    await t.test(
      "paging the original fixtures preserves price order and ID ties",
      async () => {
        const licensed = fixtures.listings.filter(
          (item) =>
            item.feedId === "feed_demo_primary" &&
            item.source.InternetEntireListingDisplayYN,
        );
        for (const sort of ["price", "-price"]) {
          const price = (item: FixtureRecord) =>
            item.source.ListPrice === null
              ? Infinity
              : Number(item.source.ListPrice) * (sort === "price" ? 1 : -1);
          const expected = licensed
            .toSorted(
              (a, b) =>
                price(a) - price(b) || a.publicId.localeCompare(b.publicId),
            )
            .map((item) => item.publicId);
          const rows = await browse(`sort=${sort}&limit=2`);
          assert.deepEqual(
            rows.map((item) => item.id),
            expected,
          );
        }
      },
    );
    await t.test(
      "paging reaches the end with null prices last in both directions, including a null cursor",
      async () => {
        await db.query(
          "UPDATE idx.listings SET price=NULL,currency=NULL WHERE id='lst_demo_0005'",
        );
        for (const sort of ["price", "-price"]) {
          const rows = await browse(`sort=${sort}&limit=1`);
          assert.equal(rows.length, licensedCount);
          assert.equal(
            new Set(rows.map((item) => item.id)).size,
            licensedCount,
          );
          assert.deepEqual(
            rows.slice(-2).map((item) => item.id),
            ["lst_demo_0004", "lst_demo_0005"],
          );
          for (let i = 1; i < rows.length - 2; i++) {
            const a = Number(rows[i - 1].price!.amount),
              b = Number(rows[i].price!.amount);
            assert.ok(sort === "price" ? a <= b : a >= b);
          }
          const full = (await request(`sort=${sort}&limit=50`)).body;
          assert.deepEqual(rows, full.data);
        }
      },
    );
    await t.test(
      "default limit is 20; positive safe integers clamp to an actual 50-result page",
      async () => {
        const extended = structuredClone(fixtures);
        for (let i = 0; i < 60; i++) {
          const record = structuredClone(fixtures.listings[0]);
          record.publicId = `lst_search_${String(i).padStart(4, "0")}`;
          record.source.ListingKey = `Synthetic search capacity ${i}`;
          extended.listings.push(record);
        }
        await seed(db, extended);
        const defaultPage = (await request()).body;
        assert.equal(defaultPage.meta.page.limit, 20);
        assert.equal(defaultPage.data.length, 20);
        assert.equal(defaultPage.meta.page.hasMore, true);
        for (const limit of ["50", "51", "9007199254740991"]) {
          const page = (await request(`limit=${limit}`)).body;
          assert.equal(page.meta.page.limit, 50);
          assert.equal(page.data.length, 50);
          assert.equal(page.meta.page.hasMore, true);
          const next = (
            await request(`limit=50&after=${page.meta.page.nextCursor}`)
          ).body;
          assert.equal(next.data.length, licensedCount + 60 - 50);
          assert.equal(next.meta.page.nextCursor, null);
        }
      },
    );
    await t.test(
      "bad, unknown and duplicate parameters fail clearly without echoing input",
      async () => {
        for (const query of [
          "unknown=query-private-marker",
          "=query-private-marker",
          "__proto__=query-private-marker",
          "offset=1",
          "city=x&city=y",
          "city=x&%63ity=y",
          "limit=1&limit=1",
          "minPrice=1&minPrice=1",
          "maxPrice=1&maxPrice=1",
          "minBedrooms=1&minBedrooms=1",
          "sort=price&sort=price",
          "after=x&after=x",
          "city=",
          "city=%20",
          `city=${"a".repeat(101)}`,
          "city=%FF",
          "city=%",
          "sort=",
          "sort=id",
          "sort=PRICE",
          "minPrice=",
          "minPrice=-1",
          "maxPrice=01",
          "minPrice=1e3",
          "maxPrice=NaN",
          "maxPrice=Infinity",
          "minPrice=.1",
          "maxPrice=1.",
          "minPrice=1&maxPrice=0.999999999999999999",
          "minPrice=10&maxPrice=9",
          "minBedrooms=-1",
          "minBedrooms=101",
          "minBedrooms=1.5",
          "minBedrooms=",
          ...[
            "0",
            "-1",
            "1.5",
            "1e2",
            "NaN",
            "Infinity",
            "",
            "9007199254740992",
            "%201",
          ].map((value) => "limit=" + value),
        ]) {
          const result = await request(query, 400);
          assert.equal(result.body.code, "invalid_query");
          assert.ok(!result.text.includes("query-private-marker"));
        }
      },
    );
    await t.test(
      "2048 raw search bytes page unchanged; oversized terms and cursors fail clearly",
      async () => {
        const query = "maxPrice=" + "9".repeat(2031) + "&limit=1";
        assert.equal(Buffer.byteLength(query), 2048);
        const first = (await request(query)).body;
        const cursor = first.meta.page.nextCursor;
        assert.equal(typeof cursor, "string");
        const rows = await browse(query);
        assert.equal(rows.length, licensedCount - 1);
        const second = (await request(`${query}&after=${cursor}`)).body;
        for (const continuation of [
          `%61fter=${cursor}&${query}`,
          query.replace("&limit=1", `&after=${cursor}&limit=1`),
        ]) {
          assert.deepEqual((await request(continuation)).body, second);
        }
        const oversized = query.replace("maxPrice=", "maxPrice=9");
        assert.equal(Buffer.byteLength(oversized), 2049);
        for (const invalid of [oversized, `${oversized}&after=${cursor}`]) {
          assert.equal(
            (await request(invalid, 400)).body.code,
            "invalid_query",
          );
        }
        const oversizedCursor = "a".repeat(CURSOR_MAX_BYTES + 1);
        const invalidCursor = await request(
          `${query}&after=${oversizedCursor}`,
          400,
        );
        assert.equal(invalidCursor.body.code, "cursor_invalid");
        const encoded = "maxPrice=" + "%39".repeat(677) + "&limit=1";
        assert.equal(Buffer.byteLength(encoded), 2048);
        const encodedFirst = (await request(encoded)).body;
        await request(`${encoded}&after=${encodedFirst.meta.page.nextCursor}`);
        const encodedError = await request(
          encoded.replace("maxPrice=", "maxPrice=9"),
          400,
        );
        assert.equal(encodedError.body.code, "invalid_query");
      },
    );
    await t.test(
      "generating a cursor no longer has a server failure path",
      async () => {
        await db.query(
          "UPDATE idx.listings SET price=$1::numeric WHERE id='lst_demo_0001'",
          ["9".repeat(2000)],
        );
        const result = await request("sort=-price&limit=1");
        assert.equal(result.body.meta.page.hasMore, true);
        assert.equal(typeof result.body.meta.page.nextCursor, "string");
        const cursor: string = result.body.meta.page.nextCursor;
        assert.ok(Buffer.byteLength(cursor) < CURSOR_MAX_BYTES);
        const remaining = await browse("sort=-price&limit=1", cursor);
        assert.equal(remaining.length, licensedCount - 1);
      },
    );
    await t.test(
      "empty results retain page disclosures; closed and withheld records reuse detail projection",
      async () => {
        const empty = (await request("city=No%20Such%20Synthetic%20City")).body;
        assert.deepEqual(empty.data, []);
        assert.deepEqual(empty.meta.page, {
          limit: 20,
          nextCursor: null,
          hasMore: false,
        });
        assert.equal(empty.display.blocks[0].id, "synthetic_notice");
        const result = await request("limit=50");
        const hidden = result.body.data.find(
          (item: Listing) => item.id === "lst_demo_0002",
        );
        assert.equal(hidden.address, null);
        assert.deepEqual(hidden.withheldFields, ["address"]);
        assert.ok(
          !result.text.includes(fixtures.listings[1].source.Address!.line1),
        );
        assert.ok(
          result.body.display.blocks.some(
            (block: DisplayBlock) => block.id === "closed_information",
          ),
        );
        for (const item of result.body.data) {
          const response = await fetch(
            `http://127.0.0.1:8787${path}/${item.id}`,
            { headers: { Authorization: `Bearer ${key.secret}` } },
          );
          assert.deepEqual(item, (await response.json()).data);
        }
        const broken = structuredClone(result.body);
        delete broken.data[0].price;
        assert.throws(
          () => validateResponse(path, result.response, broken),
          /required/,
        );
        const noDisplay = structuredClone(empty);
        delete noDisplay.display;
        assert.throws(
          () => validateResponse(path, result.response, noDisplay),
          /required/,
        );
        for (const header of ["Request-Id", "Cache-Control"]) {
          const headers = new Headers(result.response.headers);
          headers.delete(header);
          assert.throws(
            () =>
              validateResponse(
                path,
                new Response(null, { headers }),
                result.body,
              ),
            /Required header/,
          );
        }
      },
    );
    await t.test(
      "price changes shift live results and withdrawals disappear between requests",
      async () => {
        const first = (await request("limit=1")).body;
        assert.deepEqual(ids(first), ["lst_demo_0005"]);
        await db.query(
          "UPDATE idx.listings SET price=600000 WHERE id='lst_demo_0005'",
        );
        await db.query(
          "UPDATE idx.listings SET entire_listing_display=false WHERE id='lst_demo_0007'",
        );
        const rows = await browse("limit=1", first.meta.page.nextCursor);
        assert.equal(rows.length, licensedCount - 1);
        assert.equal(rows[0].id, "lst_demo_0008");
        assert.ok(!rows.some((item) => item.id === "lst_demo_0007"));
        const next = await request(
          `limit=1&after=${first.meta.page.nextCursor}`,
        );
        assert.deepEqual(ids(next.body), ["lst_demo_0008"]);
        assert.ok(
          rows.find((item) => item.id === "lst_demo_0005")!.price!.amount ===
            "600000",
        );
        await db.query(
          "DELETE FROM idx.data_licenses WHERE site_id='site_demo_primary'",
        );
        assert.equal(
          (await request(`limit=1&after=${first.meta.page.nextCursor}`, 503))
            .body.code,
          "display_rules_unavailable",
        );
      },
    );
    await t.test(
      "cursor context is normalized; malformed, tampered and mismatched cursors require restart",
      async () => {
        const base =
          "city=%20EXAMPLE%20SPRINGS%20&minPrice=330000.00&minBedrooms=0&limit=1";
        const cursor = (await request(base)).body.meta.page.nextCursor;
        await request(
          `city=example%20springs&minPrice=330000&minBedrooms=00&sort=price&limit=01&after=${cursor}`,
        );
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        for (const token of [
          "",
          "%%%",
          "a",
          cursor.slice(0, -4),
          Buffer.from("{}").toString("base64url"),
          Buffer.from(
            JSON.stringify({ ...decoded, last: { price: 5, id: "bad/id" } }),
          ).toString("base64url"),
          Buffer.from(JSON.stringify({ ...decoded, revision: 1 })).toString(
            "base64url",
          ),
        ]) {
          assert.equal(
            (await request(`${base}&after=${encodeURIComponent(token)}`, 400))
              .body.code,
            "cursor_invalid",
          );
        }
        for (const query of [
          "limit=1",
          base.replace("330000.00", "330001"),
          base.replace("minBedrooms=0", "minBedrooms=1"),
          base.replace("limit=1", "limit=2"),
          base + "&sort=-price",
          base + "&maxPrice=600000",
          base.replace("SPRINGS", "CITY"),
        ]) {
          assert.equal(
            (await request(`${query}&after=${cursor}`, 400)).body.code,
            "cursor_invalid",
          );
        }
        assert.equal(
          (await request(`${base}&after=${cursor}`, 400, other.secret)).body
            .code,
          "cursor_invalid",
        );
      },
    );
    await t.test(
      "page freshness follows the oldest displayable ingest, including on empty results",
      async () => {
        const record = structuredClone(fixtures.listings[6]);
        const partial = { feeds: [], sites: [], listings: [record] };
        const original = record.ingestedAt;
        record.ingestedAt = "2026-11-01T00:01:00Z";
        await seed(db, partial);
        const first = (await request("limit=1")).body;
        for (const body of [
          first,
          (await request(`limit=1&after=${first.meta.page.nextCursor}`)).body,
          (await request("city=No%20Such%20City")).body,
        ]) {
          assert.equal(
            body.display.freshness.ingestedAt,
            new Date(record.ingestedAt).toISOString(),
          );
        }
        assert.equal(
          first.data[0].display.freshness.ingestedAt,
          new Date(original).toISOString(),
        );
        record.ingestedAt = "2026-11-01T01:00:00Z";
        await seed(db, partial);
        const { body } = await request("city=No%20Such%20City");
        assert.deepEqual(body.data, []);
        assert.equal(
          body.display.freshness.ingestedAt,
          new Date(original).toISOString(),
        );
      },
    );
    await t.test(
      "licensed feed expiry fails closed even for empty results and on continuation",
      async () => {
        const cursor = (await request("limit=1")).body.meta.page.nextCursor;
        await db.query(
          "UPDATE idx.feeds SET expires_at='2026-11-01T01:00:00Z' WHERE id='feed_demo_primary'",
        );
        for (const query of [
          "",
          "city=No%20Such%20City",
          `limit=1&after=${cursor}`,
        ])
          assert.equal((await request(query, 503)).body.code, "feed_expired");
        await seed(db, fixtures);
        await db.query(
          "UPDATE idx.feeds SET rules_version='2' WHERE id='feed_demo_primary'",
        );
        assert.equal(
          (await request("city=No%20Such%20City", 503)).body.code,
          "display_rules_unavailable",
        );
      },
    );
    await t.test(
      "authorization, Site isolation and 405 with Allow",
      async () => {
        await request("", 401, null);
        await request("", 401, "invalid-secret-marker");
        await request("", 403, limited.secret);
        await request("", 403, key.secret, {
          headers: { Origin: "https://synthetic.example.invalid" },
        });
        assert.equal(
          (await request("", 503, other.secret)).body.code,
          "feed_expired",
        );
        await db.query(
          "UPDATE idx.feeds SET expires_at='2099-11-01T12:00:00Z' WHERE id='feed_demo_expired'",
        );
        assert.deepEqual(ids((await request("", 200, other.secret)).body), [
          "lst_demo_0023",
          "lst_demo_0024",
        ]);
        for (const method of [
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "OPTIONS",
          "HEAD",
        ])
          assert.equal(
            (
              await request("", 405, key.secret, { method })
            ).response.headers.get("Allow"),
            "GET",
          );
      },
    );
    await t.test(
      "every page seeks through listing indexes in both price orders",
      async (t) => {
        const inspect = (last: SearchQuery["last"]) => {
          const { database, queries } = explainSearch(db);
          return {
            database,
            check() {
              for (const { sql, plan } of queries) {
                const nodes = flatten(plan).filter(
                  (node) => node["Relation Name"] === "listings",
                );
                const diagnostic = JSON.stringify({ sql, plan });
                if (!sql.startsWith(listingSelect)) {
                  assert.equal(nodes.length, 0, diagnostic);
                  continue;
                }
                assert.equal(nodes.length, 1, diagnostic);
                const [node] = nodes;
                const index =
                  node["Node Type"] === "Bitmap Heap Scan"
                    ? node.Plans?.[0]
                    : node;
                assert.ok(index, diagnostic);
                assert.match(
                  index["Node Type"],
                  /^(Index (Only )?|Bitmap Index )Scan$/,
                  diagnostic,
                );
                const visited =
                  index["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0);
                assert.ok(visited <= 128, diagnostic);
                const condition = index["Index Cond"] ?? "";
                assert.match(condition, /price|id/, diagnostic);
                if (last?.price === null)
                  assert.match(condition, /id > /, diagnostic);
                for (const operator of [
                  "price >",
                  "price <",
                  "price =",
                  "id >",
                ]) {
                  if (sql.includes(`l.${operator}`))
                    assert.ok(condition.includes(operator), diagnostic);
                }
              }
            },
          };
        };
        const volume =
          process.env.IDX_TEST_SEARCH_VOLUME === "1" ? 100_000 : 2_000;
        const allFeeds = "site_search_plan_all";
        const smallFeed = "site_search_plan_small";
        const dropBedroomIndex = () =>
          db.query("DROP INDEX idx.listings_price_bedrooms_id");
        const started = performance.now();
        await db.query("BEGIN");
        try {
          if (volume === 100_000) await dropBedroomIndex();
          await db.query(`
            INSERT INTO idx.feeds
              (id, refreshed_at, expires_at, display_blocks, rules_version)
            SELECT new_id.id, f.refreshed_at, f.expires_at, '[]', f.rules_version
            FROM idx.feeds f
            CROSS JOIN (VALUES ('feed_search_plan_second'), ('feed_search_plan_small'))
              AS new_id(id)
            WHERE f.id = 'feed_demo_primary';
            INSERT INTO idx.sites VALUES ('site_search_plan_all'), ('site_search_plan_small');
            INSERT INTO idx.data_licenses VALUES
              ('site_search_plan_all', 'feed_demo_primary'),
              ('site_search_plan_all', 'feed_search_plan_second'),
              ('site_search_plan_all', 'feed_search_plan_small'),
              ('site_search_plan_small', 'feed_search_plan_small');
          `);
          // Invented runner-only data with a few common cities and rare bedroom counts.
          const loaded = await db.query(
            `
            WITH inserted AS (
              INSERT INTO idx.listings
                (id, synthetic, price, currency, address, bedrooms, withheld_fields,
                 entire_listing_display, display_blocks, page_blocks, ingested_at)
              SELECT 'lst_search_plan_' || lpad(n::text, 6, '0'), true,
                350000 + (n % 5000) * 100, 'USD',
                jsonb_build_object('city', CASE
                  WHEN city_bucket < 45 THEN 'Synthetic City'
                  WHEN city_bucket < 80 THEN 'Synthetic Town'
                  ELSE 'Synthetic Place ' || (n % 101)
                END),
                CASE WHEN bedroom_bucket = 0 THEN 7 ELSE 2 + bedroom_bucket % 4 END,
                '{}', true, '[]', '[]', '2026-11-01T00:05:00Z'
              FROM generate_series(1, $1::int) AS series(n)
              CROSS JOIN LATERAL (
                SELECT (hashint4(n)::bigint & 2147483647) % 100 AS city_bucket,
                  (hashint4(n + 100000)::bigint & 2147483647) % 100 AS bedroom_bucket
              ) buckets
              RETURNING id
            )
            INSERT INTO idx.source_mappings (feed_id, source_key, listing_id)
            SELECT CASE
              WHEN right(id, 6)::int % 200 = 0 THEN 'feed_search_plan_small'
              WHEN right(id, 6)::int % 3 = 0 THEN 'feed_search_plan_second'
              ELSE 'feed_demo_primary'
            END, id, id FROM inserted
          `,
            [volume],
          );
          assert.equal(loaded.rowCount, volume);
          if (volume === 100_000) {
            const migration = await readFile(
              new URL(
                "../../packages/engine/migrations/005_listings_price_bedrooms_id.sql",
                import.meta.url,
              ),
              "utf8",
            );
            const buildStarted = performance.now();
            await db.query(migration);
            const buildMs = performance.now() - buildStarted;
            t.diagnostic(
              `Bedroom index build with ${volume} synthetic listings took ${buildMs.toFixed(1)} ms`,
            );
          }
          await db.query(
            "UPDATE idx.listings SET price = 350000, currency = 'USD' WHERE price IS NULL",
          );
          for (const withNulls of [false, true]) {
            if (withNulls) {
              await db.query(
                "UPDATE idx.listings SET price = NULL, currency = NULL WHERE id BETWEEN $1 AND $2",
                ["lst_search_plan_000001", "lst_search_plan_000100"],
              );
            }
            await db.query(
              "ANALYZE idx.listings, idx.source_mappings, idx.data_licenses, idx.feeds",
            );
            for (const sort of ["price", "-price"]) {
              const query = searchQuery(
                searchSchema.parse({ sort, limit: "50" }),
                allFeeds,
              );
              const fetchSize = query.context.limit + 1;
              const boundary = {
                price: sort === "price" ? "900000" : "0",
                id: "lst_demo_0023",
              };
              const positions: SearchQuery["last"][] = [
                null,
                { price: "425000", id: "lst_demo_0002" },
                boundary,
              ];
              if (withNulls)
                positions.push({ price: null, id: "lst_search_plan_000001" });
              for (const last of positions) {
                const { database, check } = inspect(last);
                const result = await searchListings(database, {
                  ...query,
                  last,
                });
                check();
                if (last === boundary || last?.price === null) {
                  assert.equal(result.rows.length, withNulls ? fetchSize : 0);
                  assert.ok(result.rows.every((row) => row.price === null));
                } else {
                  assert.equal(result.rows.length, fetchSize);
                  assert.ok(result.rows.every((row) => row.price !== null));
                }
              }
            }
          }
          if (volume === 100_000) {
            const measurements: string[] = [];
            const violations: string[] = [];
            // Allow several B-tree and heap accesses per row of the 500-listing
            // feed, plus the license lookup and any continuation tie query.
            const blockBudget = 4096;
            const measure = async (
              label: string,
              filters: Record<string, string>,
              site = allFeeds,
            ) => {
              for (const sort of ["price", "-price"]) {
                const query = searchQuery(
                  searchSchema.parse({ ...filters, sort, limit: "50" }),
                  site,
                );
                const fetchSize = query.context.limit + 1;
                // Count both listing rows and source mappings. Allow some extra
                // candidates for selective filters and sites with few licenses.
                const budget = 32 * fetchSize;
                let last: SearchQuery["last"] = null;
                for (const page of [1, 2]) {
                  const { database, queries } = explainSearch(db);
                  const { rows } = await searchListings(database, {
                    ...query,
                    last,
                  });
                  const result = summarizeSearch(queries);
                  const name = `${label} | ${sort} | ${page}`;
                  measurements.push(
                    `| ${name} | ${result.rows} | ${result.sharedBlocks} | ${result.ms.toFixed(3)} | ${result.plan} |`,
                  );
                  if (result.listingSeqScan || result.rows > budget) {
                    const scan = result.listingSeqScan
                      ? " (listings Seq Scan)"
                      : "";
                    violations.push(
                      `${name} examined ${result.rows}/${budget} rows${scan}`,
                    );
                  }
                  if (result.sharedBlocks > blockBudget) {
                    violations.push(
                      `${name} accessed ${result.sharedBlocks}/${blockBudget} shared blocks`,
                    );
                  }
                  assert.equal(rows.length, fetchSize, name);
                  const { price, id } = rows[query.context.limit - 1];
                  last = { price, id };
                }
              }
            };
            const minPrice = "375000";
            const maxPrice = "824900";
            const city = "Synthetic City";
            const minBedrooms = "7";
            const ranges: [string, Record<string, string>][] = [
              ["plain", {}],
              ["min price", { minPrice }],
              ["max price", { maxPrice }],
              ["wide price range", { minPrice, maxPrice }],
            ];
            for (const [priceLabel, prices] of ranges) {
              await measure(priceLabel, prices);
              await measure(`${priceLabel} + rare bedrooms`, {
                ...prices,
                minBedrooms,
              });
              await measure(`${priceLabel} + common city`, { ...prices, city });
              await measure(`${priceLabel} + rare bedrooms + common city`, {
                ...prices,
                minBedrooms,
                city,
              });
            }
            await measure("rare city", { city: "Synthetic Place 50" });
            await measure("common bedrooms", { minBedrooms: "3" });
            await measure("narrow price range", {
              minPrice: "400000",
              maxPrice: "450000",
            });
            await measure("small feed", {}, smallFeed);
            await measure(
              "small feed + wide range + common city",
              { minPrice, maxPrice, city },
              smallFeed,
            );
            t.diagnostic(
              [
                "| Search | Sort | Page | Rows examined | Shared blocks | PostgreSQL ms | Plan |",
                "| --- | --- | --- | ---: | ---: | ---: | --- |",
                ...measurements,
              ].join("\n"),
            );
            // Compare the same sparse search against the same rows and stats.
            // The surrounding rollback also restores the original index.
            await dropBedroomIndex();
            const { database, queries } = explainSearch(db);
            const query = searchQuery(
              searchSchema.parse({
                minPrice,
                maxPrice,
                minBedrooms,
                city,
                sort: "-price",
                limit: "50",
              }),
              allFeeds,
            );
            const { rows } = await searchListings(database, query);
            assert.equal(rows.length, query.context.limit + 1);
            const control = summarizeSearch(queries);
            const diagnostic = `Sparse search without the bedroom index accessed ${control.sharedBlocks} shared blocks (budget ${blockBudget})`;
            t.diagnostic(diagnostic);
            assert.ok(control.sharedBlocks > blockBudget, diagnostic);
            assert.deepEqual(violations, []);
          }
        } finally {
          await db.query("ROLLBACK");
          const elapsed = (performance.now() - started) / 1000;
          t.diagnostic(
            `Search plan proof with ${volume} synthetic listings took ${elapsed.toFixed(2)}s`,
          );
        }
      },
    );
    await t.test(
      "withheld synthetic facts are null in storage, responses, filters and cursors",
      async () => {
        const extra = JSON.parse(
          await readFile(
            new URL("../../fixtures/withheld-listings.json", import.meta.url),
            "utf8",
          ),
        ) as FixtureRecord[];
        extra[3].source.ListPrice = null;
        const extended = structuredClone(fixtures);
        extended.listings.push(...extra);
        try {
          await seed(db, extended);
          const stored = (
            await db.query(
              "SELECT * FROM idx.listings WHERE id LIKE 'lst_withheld_%' ORDER BY id",
            )
          ).rows;
          for (let index = 0; index < extra.length; index++) {
            const field = extra[index].withheldFields![0];
            assert.equal(stored[index][field], null);
            assert.deepEqual(stored[index].withheld_fields, [field]);
            if (field === "price") assert.equal(stored[index].currency, null);
            const response = await fetch(
              `http://127.0.0.1:8787${path}/${extra[index].publicId}`,
              { headers: { Authorization: `Bearer ${key.secret}` } },
            );
            const detail = await response.json();
            validateResponse(path + "/{listingId}", response, detail);
            assert.equal(detail.data[field], null);
            assert.deepEqual(detail.data.withheldFields, [field]);
          }
          assert.ok(
            !ids((await request("minPrice=0&limit=50")).body).includes(
              extra[0].publicId,
            ),
          );
          assert.ok(
            !ids((await request("minBedrooms=0&limit=50")).body).includes(
              extra[2].publicId,
            ),
          );
          for (const sort of ["price", "-price"]) {
            const all: Listing[] = [];
            let cursor: string | null = null;
            do {
              const body: SearchResponse = (
                await request(
                  `sort=${sort}&limit=1` + (cursor ? "&after=" + cursor : ""),
                )
              ).body;
              const listing = body.data[0];
              all.push(listing);
              cursor = body.meta.page.nextCursor;
              if (cursor) {
                const decoded = JSON.parse(
                  Buffer.from(cursor, "base64url").toString(),
                );
                if (listing.id === extra[0].publicId) {
                  assert.equal(decoded[0], null);
                  assert.ok(
                    !JSON.stringify(decoded).includes(
                      extra[0].source.ListPrice!,
                    ),
                  );
                }
                assert.equal(decoded.length, 3);
              }
            } while (cursor);
            assert.equal(all.at(-1)!.id, extra[3].publicId);
            assert.ok(all.slice(-3).every((listing) => listing.price === null));
            for (const record of extra) {
              const item = all.find(
                (listing) => listing.id === record.publicId,
              )!;
              const field = record.withheldFields![0];
              assert.equal(item[field], null);
              assert.deepEqual(item.withheldFields, [field]);
            }
          }
        } finally {
          await db.query(
            "DELETE FROM idx.source_mappings WHERE listing_id LIKE 'lst_withheld_%'",
          );
          await db.query(
            "DELETE FROM idx.listings WHERE id LIKE 'lst_withheld_%'",
          );
          await seed(db, fixtures);
        }
      },
    );
    await t.test(
      "search logs correlate errors and successes without queries or credentials",
      async () => {
        await engine.stop();
        const text = engine.logs();
        for (const value of [
          key.secret,
          other.secret,
          limited.secret,
          "query-private-marker",
          "invalid-secret-marker",
          "minPrice=",
          "after=",
        ])
          assert.ok(!text.includes(value));
        const logs = text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        for (const request of requests) {
          const matches = logs.filter((line) => line.requestId === request.id);
          assert.equal(matches.length, 1);
          assert.equal(matches[0].route, path);
          assert.equal(matches[0].status, request.status);
          assert.equal(matches[0].code, request.code);
        }
      },
    );
  },
);
