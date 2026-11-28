import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pg from "pg";
import type { DisplayBlock, Listing } from "@idx-kit/client";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import {
  applyListingPage,
  applyScanDisclosures,
  listingFeedTransaction,
  listingPageLimit,
} from "@idx-kit/engine/src/db/listings.ts";
import type { ListingChange } from "@idx-kit/engine/src/db/listings.ts";
import { repository } from "@idx-kit/engine/src/db/read.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { createApp } from "@idx-kit/engine/src/http/app.ts";
import { workerRuntime } from "../workers/runtime.ts";
import { contract, valid, validateResponse } from "./contract.ts";
import { fixtureDisclosures } from "./listing-page.ts";
import {
  keyCommand,
  preserveKeys,
  setListingRequestLimit,
  startEngine,
} from "./runtime.ts";

test("real HTTP listing and key acceptance", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(`${tmpdir()}/idx-api-`);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const restoreOriginalKeys = await preserveKeys(db);
  t.after(async () => {
    try {
      await restoreOriginalKeys();
    } finally {
      try {
        await db.end();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  const fixtures = await new FixtureConnector().read();
  t.afterEach(() => seed(db, fixtures));
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
    "inquiries:write,inquiries:read",
    "limited",
  );
  const secrets = [key.secret, other.secret, limited.secret];
  await setListingRequestLimit(db, key.id, 1000);
  const restoreSuiteKeys = await preserveKeys(db);
  t.afterEach(restoreSuiteKeys);
  const engine = await startEngine();
  t.after(() => engine.stop());
  const requests: { id: string; status: number; code: string }[] = [];
  const detailPath = "/api/v1/listings/{listingId}";
  const listing = "/api/v1/listings/lst_demo_0001";
  const ids = new Set<string>();
  async function request(
    path: string,
    status = 200,
    secret: string | null = key.secret,
    init: RequestInit = {},
  ) {
    const headers = new Headers(init.headers);
    if (secret !== null) headers.set("Authorization", `Bearer ${secret}`);
    headers.set("Request-Id", "untrusted-request-id");
    const response = await fetch(`http://127.0.0.1:8787${path}`, {
      ...init,
      headers,
    });
    assert.equal(response.status, status);
    const id = response.headers.get("Request-Id")!;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.ok(!ids.has(id));
    ids.add(id);
    assert.ok(
      !Array.from(response.headers.keys()).some((name) =>
        name.startsWith("access-control-"),
      ),
    );
    const text = await response.text();
    const body = init.method === "HEAD" ? undefined : JSON.parse(text);
    const schemaPath = /^\/api\/v1\/listings\/[^/?]+/.test(path)
      ? detailPath
      : path.split("?")[0];
    validateResponse(schemaPath, response, body, init.method === "HEAD");
    if (status >= 400 && body) {
      assert.equal(body.status, status);
      assert.equal(body.requestId, id);
      assert.ok(!text.includes("untrusted-request-id"));
    }
    requests.push({
      id,
      status,
      code: body?.code ?? (status === 405 ? "method_not_allowed" : "ok"),
    });
    return { body, response, text };
  }
  await t.test(
    "feed pages apply ordered, scoped changes and clear unsafe data",
    async (t) => {
      assert.ok(process.env.LISTING_WRITER_DATABASE_URL);
      const writer = new pg.Client({
        connectionString: process.env.LISTING_WRITER_DATABASE_URL,
      });
      await writer.connect();
      const primary = "feed_demo_primary";
      const secondary = "feed_demo_expired";
      t.after(async () => {
        await writer.end();
        await db.query(`
        DELETE FROM idx.listings l USING idx.source_mappings m
          WHERE l.id = m.listing_id AND m.source_key LIKE 'Synthetic writer %';
        DELETE FROM idx.source_mappings WHERE source_key LIKE 'Synthetic writer %';
      `);
      });
      const feed = fixtureDisclosures(fixtures, primary);
      const applyNotices = (disclosures = feed) =>
        listingFeedTransaction(writer, primary, () =>
          applyScanDisclosures(writer, primary, disclosures),
        );
      const write = (changes: ListingChange[]) =>
        applyListingPage(writer, primary, changes, {
          initialDisclosures: feed,
        });
      const sourceKey = "Synthetic writer shared key";
      const otherKey = "Synthetic writer companion key";
      const oldStreet = "999 Synthetic Writer Way";
      const oldPhoto = "https://images.example.invalid/old-writer-photo.svg";
      const newPhoto = "https://images.example.invalid/new-writer-photo.svg";
      const revision = (number: number) =>
        `2026-11-02T00:00:00.${String(number).padStart(6, "0")}Z`;
      const upsert = (sourceKey: string, number: number) => ({
        kind: "upsert" as const,
        sourceKey,
        revision: revision(number),
        listing: structuredClone(fixtures.listings[0]),
      });
      const identity = async (feed: string, source: string) => {
        const { rows } = await db.query(
          "SELECT listing_id FROM idx.source_mappings WHERE feed_id=$1 AND source_key=$2",
          [feed, source],
        );
        assert.equal(rows.length, 1);
        return String(rows[0].listing_id);
      };
      const stored = async (id: string) =>
        (await db.query("SELECT * FROM idx.listings WHERE id=$1", [id])).rows;
      const search = () => request("/api/v1/listings?limit=50");
      const original = upsert(sourceKey, 1);
      original.listing.source.Address!.line1 = oldStreet;
      original.listing.source.Images = [{ url: oldPhoto, alt: oldStreet }];
      original.listing.ingestedAt = "2026-11-01T00:01:00Z";
      await write([original, upsert(otherKey, 1)]);
      await applyListingPage(writer, secondary, [upsert(sourceKey, 1)], {
        initialDisclosures: fixtureDisclosures(fixtures, secondary),
      });
      const id = await identity(primary, sourceKey);
      const second = await identity(secondary, sourceKey);
      const companion = await identity(primary, otherKey);
      const detail = `/api/v1/listings/${id}`;
      assert.notEqual(id, second);
      const secondFacts = await stored(second);
      assert.ok((await request(detail)).text.includes(oldPhoto));

      const replacement = upsert(sourceKey, 2);
      replacement.listing.source.ListPrice = "123456.78";
      replacement.listing.source.Address!.line1 = "1000 Synthetic Writer Way";
      replacement.listing.source.Images = [{ url: newPhoto, alt: "New photo" }];
      replacement.listing.blocks[0].text = oldStreet;
      await write([replacement, original]);
      await write([replacement]);
      await write([original]);
      for (const value of [
        JSON.stringify(await stored(id)),
        (await request(detail)).text,
        (await search()).text,
      ]) {
        assert.ok(!value.includes(oldStreet));
        assert.ok(!value.includes(oldPhoto));
        assert.ok(value.includes(newPhoto));
      }
      const updated = (await request(detail)).body.data;
      assert.equal(updated.address.line1, "1000 Synthetic Writer Way");
      assert.equal(updated.price.amount, "123456.78");
      assert.deepEqual(await stored(second), secondFacts);
      assert.equal(
        (await search()).body.display.freshness.ingestedAt,
        new Date(fixtures.listings[0].ingestedAt).toISOString(),
      );

      const unknown = (
        await request("/api/v1/listings/lst_missing_writer", 404)
      ).body;
      const absent = async (hiddenId: string) => {
        const { body } = await request(`/api/v1/listings/${hiddenId}`, 404);
        assert.deepEqual(
          { ...body, requestId: "" },
          { ...unknown, requestId: "" },
        );
        assert.ok(
          !(await search()).body.data.some(
            (item: Listing) => item.id === hiddenId,
          ),
        );
        assert.deepEqual(await stored(hiddenId), []);
      };
      for (const [index, kind] of [
        "withdrawn",
        "deleted",
        "upsert",
        "sold",
      ].entries()) {
        const liveRevision = 3 + index * 2;
        const live = upsert(sourceKey, liveRevision);
        const hidden = upsert(sourceKey, liveRevision + 1);
        hidden.listing.source.InternetEntireListingDisplayYN =
          kind !== "upsert";
        if (kind === "sold") hidden.listing.source.StandardStatus = "closed";
        await write([live]);
        await request(detail);
        await write([
          kind === "withdrawn" || kind === "deleted"
            ? { ...hidden, kind }
            : hidden,
          live,
        ]);
        await absent(id);
        await write([live]);
        await absent(id);
        assert.equal(await identity(primary, sourceKey), id);
      }
      const restored = upsert(sourceKey, 11);
      restored.listing.source.Address!.line1 = oldStreet;
      await write([restored]);
      assert.equal((await request(detail)).body.data.id, id);
      assert.equal(
        (await request("/api/v1/listings/lst_demo_0003")).body.data.status,
        "closed",
      );

      const unsafe = upsert(sourceKey, 12);
      unsafe.listing.source.Address = null;
      unsafe.listing.source.InternetAddressDisplayYN = false;
      unsafe.listing.source.BedroomsTotal = -1;
      const result = await write([
        unsafe,
        { kind: "deleted", sourceKey: otherKey, revision: revision(12) },
        upsert("Synthetic writer valid sibling", 12),
        upsert("", 12),
      ]);
      assert.deepEqual(result.rejected, [
        { index: 0, code: "invalid_change", hidden: true },
        { index: 3, code: "invalid_key", hidden: false },
      ]);
      await absent(id);
      await absent(companion);
      const sibling = await identity(primary, "Synthetic writer valid sibling");
      await request(`/api/v1/listings/${sibling}`);
      await assert.rejects(
        write(Array(listingPageLimit + 1).fill(restored)),
        /Listing page too large/,
      );
      await assert.rejects(writer.query("SELECT * FROM idx.inquiries"), {
        code: "42501",
      });
      await assert.rejects(
        writer.query("UPDATE idx.feeds SET expires_at=now()"),
        { code: "42501" },
      );

      const remove = (sourceKey: string, number: number) => ({
        kind: "withdrawn" as const,
        sourceKey,
        revision: revision(number),
      });
      const publicDetail = (id: string) => request(`/api/v1/listings/${id}`);
      const searchItem = async (id: string) => {
        const result = (await search()).body.data.find(
          (item: Listing) => item.id === id,
        );
        assert.ok(result);
        return result as Listing;
      };
      const hiddenAddress = (sourceKey: string, number: number) => {
        const change = upsert(sourceKey, number);
        change.listing.source.Address = null;
        change.listing.source.InternetAddressDisplayYN = false;
        return change;
      };

      await t.test(
        "off-market, empty, and missing feed statuses hide listings",
        async () => {
          const key = "Synthetic writer removal statuses";
          const statuses = [
            "Canceled",
            "Closed",
            "Delete",
            "Expired",
            "Incomplete",
            "Withdrawn",
            "Deleted",
            "Sold",
            "Hold",
            "",
            null,
            undefined,
          ];
          for (const [index, status] of statuses.entries()) {
            const live = upsert(key, index * 2 + 1);
            const removed = upsert(key, index * 2 + 2);
            if (status === undefined) {
              Reflect.deleteProperty(removed.listing.source, "StandardStatus");
            } else {
              removed.listing.source.StandardStatus = status;
            }
            await write([live]);
            const id = await identity(primary, key);
            assert.equal((await publicDetail(id)).body.data.status, "active");
            assert.equal((await searchItem(id)).status, "active");
            assert.deepEqual((await write([removed])).rejected, []);
            await absent(id);
            if (status === "Hold") {
              await write([live]);
              await absent(id);
              await write([upsert(key, index * 2 + 3)]);
              const restored = (await publicDetail(id)).body.data;
              assert.equal(restored.id, id);
              assert.equal(restored.status, "active");
            }
          }
        },
      );

      await t.test("all four on-market statuses stay visible", async () => {
        const key = "Synthetic writer on-market statuses";
        const statuses = [
          "Active",
          "Active Under Contract",
          "Coming Soon",
          "Pending",
        ];
        for (const [index, status] of statuses.entries()) {
          const change = upsert(key, index + 1);
          change.listing.source.StandardStatus = status;
          assert.deepEqual((await write([change])).rejected, []);
          const id = await identity(primary, key);
          const expected = status.toLowerCase();
          assert.equal((await publicDetail(id)).body.data.status, expected);
          assert.equal((await searchItem(id)).status, expected);
        }
      });

      await t.test("fixtures retain their own status rules", async () => {
        const record = structuredClone(fixtures.listings[0]);
        record.publicId = "lst_writer_fixture_delete";
        record.source.ListingKey = "Synthetic writer fixture delete";
        record.source.StandardStatus = "closed";
        const batch = { feeds: [], sites: [], listings: [record] };
        await seed(db, batch);
        assert.equal(
          (await publicDetail(record.publicId)).body.data.status,
          "closed",
        );
        record.source.StandardStatus = "Unrecognized";
        await seed(db, batch);
        assert.equal(
          (await publicDetail(record.publicId)).body.data.status,
          "Unrecognized",
        );
        assert.equal(
          (await searchItem(record.publicId)).status,
          "Unrecognized",
        );
        record.source.StandardStatus = "Delete";
        await seed(db, batch);
        await absent(record.publicId);
      });

      await t.test(
        "feed photos are checked individually within the first 128 entries",
        async () => {
          const key = "Synthetic writer photo validation";
          const open = upsert(key, 1);
          Object.assign(open.listing.source, {
            Images: [
              { url: newPhoto, alt: oldStreet },
              {
                url: `/media/${encodeURIComponent(oldStreet)}${"x".repeat(2048)}.svg`,
              },
              null,
            ],
          });
          assert.deepEqual((await write([open])).rejected, []);
          const id = await identity(primary, key);
          assert.deepEqual((await publicDetail(id)).body.data.images, [
            { url: newPhoto, alt: oldStreet },
          ]);

          const many = upsert(key, 2);
          const photos = Array.from({ length: 130 }, (_, index) => ({
            url: `/media/synthetic-${index}.svg`,
            alt: `Property photo ${index}`,
          }));
          many.listing.source.Images = photos;
          assert.deepEqual((await write([many])).rejected, []);
          assert.deepEqual((await searchItem(id)).images, photos.slice(0, 128));

          const malformed = upsert(key, 3);
          Object.assign(malformed.listing.source, {
            Images: { url: newPhoto },
          });
          assert.deepEqual((await write([malformed])).rejected, []);
          assert.equal((await publicDetail(id)).body.data.images, null);
        },
      );

      await t.test(
        "equal revisions keep the most restrictive address permission in either order",
        async () => {
          for (const [index, [reverse, samePage]] of [
            [false, false],
            [true, false],
            [false, true],
            [true, true],
          ].entries()) {
            const key = `Synthetic writer tied address ${index}`;
            const open = upsert(key, 1);
            open.listing.source.Address!.line1 = oldStreet;
            open.listing.source.Images = [{ url: oldPhoto, alt: oldStreet }];
            if (samePage) open.listing.withheldFields = ["bedrooms", "price"];
            const closed = hiddenAddress(key, 1);
            const changes = reverse ? [closed, open] : [open, closed];
            if (samePage) await write(changes);
            else {
              for (const change of changes) await write([change]);
            }
            const id = await identity(primary, key);
            const [row] = await stored(id);
            assert.equal(row.address, null);
            assert.deepEqual(row.images, []);
            assert.ok(row.withheld_fields.includes("address"));
            for (const item of [
              (await publicDetail(id)).body.data,
              await searchItem(id),
            ]) {
              assert.equal(item.address, null);
              assert.deepEqual(item.images, []);
              assert.ok(item.withheldFields.includes("address"));
            }
          }
        },
      );

      await t.test(
        "property photos are cleared when a feed withholds the address",
        async () => {
          const key = "Synthetic writer photo permissions";
          const open = upsert(key, 1);
          open.listing.source.Address!.line1 = oldStreet;
          const encoded = encodeURIComponent(oldStreet);
          const reference = { url: `/media/${encoded}.svg`, alt: "Side view" };
          const photos = [{ url: newPhoto, alt: oldStreet }, reference];
          const blanks = [
            { url: "/media/blank.svg", alt: "" },
            { url: "/media/spaces.svg", alt: " ".repeat(1025) },
            { url: "/media/missing.svg" },
          ];
          const generic = ({ url }: { url: string }) => ({
            url,
            alt: "Property photo",
          });
          open.listing.source.Images = [...photos, ...blanks];
          assert.deepEqual((await write([open])).rejected, []);
          const id = await identity(primary, key);
          const expected = [...photos, ...blanks.map(generic)];
          assert.deepEqual((await searchItem(id)).images, expected);
          assert.deepEqual((await publicDetail(id)).body.data.images, expected);

          const hidden = upsert(key, 2);
          hidden.listing.source.InternetAddressDisplayYN = false;
          hidden.listing.source.Address!.line1 = oldStreet;
          hidden.listing.source.Images = photos;
          assert.deepEqual((await write([hidden])).rejected, []);
          const [row] = await stored(id);
          assert.deepEqual(row.images, []);
          assert.deepEqual((await searchItem(id)).images, []);
          assert.deepEqual((await publicDetail(id)).body.data.images, []);

          const unknownKey = `${key} unknown street`;
          const unknownStreet = hiddenAddress(unknownKey, 1);
          unknownStreet.listing.source.Images = [reference];
          assert.deepEqual((await write([unknownStreet])).rejected, []);
          const unknownId = await identity(primary, unknownKey);
          assert.deepEqual((await searchItem(unknownId)).images, []);
          assert.deepEqual(
            (await publicDetail(unknownId)).body.data.images,
            [],
          );
        },
      );

      await t.test(
        "search and detail hide photos left in a stored row with a withheld address",
        async () => {
          const id = "lst_writer_legacy_photos";
          await db.query(
            `WITH copied AS (
              INSERT INTO idx.listings
                (id, synthetic, status, price, currency, bedrooms, images,
                 withheld_fields, entire_listing_display, display_blocks,
                 page_blocks, source_updated_at, ingested_at)
              SELECT $1, synthetic, status, price, currency, bedrooms, images,
                ARRAY['address'], true, display_blocks, page_blocks,
                source_updated_at, ingested_at
              FROM idx.listings WHERE id = 'lst_demo_0001'
              RETURNING id, source_updated_at
            )
            INSERT INTO idx.source_mappings (feed_id, source_key, listing_id, source_revision)
            SELECT $2, $3, id, source_updated_at FROM copied`,
            [id, primary, "Synthetic writer legacy photos"],
          );
          const [row] = await stored(id);
          assert.deepEqual(row.images, fixtures.listings[0].source.Images);
          for (const item of [
            (await publicDetail(id)).body.data,
            await searchItem(id),
          ]) {
            assert.deepEqual(item.withheldFields, ["address"]);
            assert.deepEqual(item.images, []);
          }
        },
      );

      await t.test(
        "approved disclosures replace legacy blocks and ignore carried property photos",
        async () => {
          const key = "Synthetic writer legacy disclosure";
          const open = upsert(key, 1);
          open.listing.source.Address!.line1 = "998 Imaginary Disclosure Road";
          open.listing.source.Images = [{ url: oldPhoto, alt: "Old photo" }];
          await write([open]);
          const id = await identity(primary, key);
          const stale = {
            ...open.listing.blocks[0],
            text: `Disclosure with ${open.listing.source.Address!.line1} and ${oldPhoto}`,
            image: { url: oldPhoto, alt: open.listing.source.Address!.line1 },
          };
          await db.query(
            "UPDATE idx.listings SET display_blocks=$2, page_blocks=$2 WHERE id=$1",
            [id, JSON.stringify([stale])],
          );
          await db.query("UPDATE idx.feeds SET display_blocks=$2 WHERE id=$1", [
            primary,
            JSON.stringify([...feed.approvedFeedBlocks, stale]),
          ]);
          const replacement = hiddenAddress(key, 2);
          const notice = {
            ...open.listing.blocks[0],
            id: "synthetic_page_notice",
            text: "Synthetic property information.  Keep the spacing!",
          };
          replacement.listing.blocks = [stale];
          replacement.listing.pageBlocks = [{ ...stale, id: notice.id }];
          await applyNotices({ ...feed, approvedPageBlocks: [notice] });
          assert.deepEqual((await write([replacement])).rejected, []);
          const feedRow = await db.query(
            "SELECT display_blocks FROM idx.feeds WHERE id=$1",
            [primary],
          );
          const empty = await request("/api/v1/listings?city=No%20Such%20City");
          assert.deepEqual(empty.body.data, []);
          assert.deepEqual(empty.body.display.blocks, feed.approvedFeedBlocks);
          const { body } = await publicDetail(id);
          assert.deepEqual(
            body.data.display.blocks,
            feed.approvedListingBlocks,
          );
          assert.deepEqual(body.display.blocks, [
            ...feed.approvedFeedBlocks,
            notice,
          ]);
          for (const payload of [
            feedRow.rows,
            await stored(id),
            (await publicDetail(id)).body,
            (await search()).body,
          ]) {
            const text = JSON.stringify(payload);
            assert.ok(!text.includes(oldPhoto));
            assert.ok(!text.includes(open.listing.source.Address!.line1));
          }
        },
      );

      await t.test(
        "search uses one snapshot when a writer replaces disclosures mid-request",
        async (t) => {
          const reader = new pg.Client({
            connectionString: process.env.RUNTIME_DATABASE_URL,
          });
          await reader.connect();
          t.after(() => reader.end());
          const app = createApp(
            repository(reader),
            contract,
            "snapshot-test",
            () => {},
          );
          const query = reader.query.bind(reader);
          let afterFeeds: (() => Promise<void>) | undefined;
          const counted = t.mock.method(
            reader,
            "query",
            async (sql: string, values: unknown[]) => {
              const result = await query(sql, values);
              if (sql.includes("oldest_listing_ingested_at") && afterFeeds) {
                const commit = afterFeeds;
                afterFeeds = undefined;
                await commit();
              }
              return result;
            },
          );
          for (const empty of [false, true]) {
            const key = `Synthetic writer search snapshot ${empty}`;
            const open = upsert(key, 1);
            open.listing.source.Address!.line1 = oldStreet;
            await write([open]);
            const id = await identity(primary, key);
            const stale = {
              ...feed.approvedFeedBlocks[0],
              text: `${oldStreet} ${oldPhoto}`,
            };
            await applyNotices({ ...feed, approvedFeedBlocks: [stale] });
            afterFeeds = async () => {
              const change = empty ? upsert(key, 2) : hiddenAddress(key, 2);
              if (empty)
                change.listing.source.Address!.city = "Imaginary Snapshot City";
              await applyNotices();
              await write([change]);
            };
            const path = empty
              ? "/api/v1/listings?city=Imaginary%20Snapshot%20City"
              : "/api/v1/listings?limit=50";
            counted.mock.resetCalls();
            const response = await app.request(path, {
              headers: { Authorization: `Bearer ${secrets[0]}` },
            });
            assert.equal(response.status, 200);
            assert.equal(counted.mock.callCount(), 6);
            const earlier = await response.json();
            validateResponse("/api/v1/listings", response, earlier);
            assert.equal(afterFeeds, undefined);
            assert.ok(
              earlier.display.blocks.some(
                (block: DisplayBlock) => block.text === stale.text,
              ),
            );
            const later = (await request(path)).body;
            assert.ok(!JSON.stringify(later).includes(stale.text));
            if (empty) {
              assert.deepEqual(earlier.data, []);
              assert.deepEqual(
                later.data.map((item: Listing) => item.id),
                [id],
              );
            } else {
              assert.equal(
                earlier.data.find((item: Listing) => item.id === id).address
                  .line1,
                oldStreet,
              );
              assert.equal(
                later.data.find((item: Listing) => item.id === id).address,
                null,
              );
            }
          }
        },
      );

      await t.test(
        "a connection dropped during search returns 503 and the Node engine recovers",
        { skip: workerRuntime },
        async (t) => {
          const observer = new pg.Client({
            connectionString: process.env.RUNTIME_DATABASE_URL,
          });
          await observer.connect();
          t.after(() => observer.end());
          await db.query("BEGIN");
          try {
            await db.query("LOCK TABLE idx.feeds IN ACCESS EXCLUSIVE MODE");
            const pending = request("/api/v1/listings", 503);
            void pending.catch(() => {});
            let terminated = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const { rows } = await observer.query(`
                SELECT pg_terminate_backend(pid, 500) AS terminated
                FROM pg_stat_activity
                WHERE usename = current_user AND pid <> pg_backend_pid()
                  AND query LIKE '%oldest_listing_ingested_at%'
                  AND wait_event_type = 'Lock'
              `);
              if (rows.length) {
                terminated = rows[0].terminated;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(
              terminated,
              "The active search connection was terminated",
            );
            assert.equal((await pending).body.code, "service_unavailable");
          } finally {
            await db.query("ROLLBACK");
          }
          await search();
        },
      );

      await t.test(
        "an unreadable removal wins even against a readable revision on the same page",
        async () => {
          const key = "Synthetic writer unreadable revision";
          await write([upsert(key, 1)]);
          const id = await identity(primary, key);
          const newer = upsert(key, 2);
          const bad = { ...remove(key, 0), revision: "unreadable" };
          assert.deepEqual((await write([newer, bad])).rejected, [
            { index: 1, code: "invalid_change", hidden: true },
          ]);
          await write([newer]);
          await absent(id);
          const result = await db.query(
            "SELECT source_revision::text FROM idx.source_mappings WHERE listing_id=$1",
            [id],
          );
          assert.equal(result.rows[0].source_revision, "infinity");
        },
      );

      await t.test(
        "only a valid authoritative upsert clears an order-unknown tombstone",
        async (t) => {
          const peer = new pg.Client({
            connectionString: process.env.LISTING_WRITER_DATABASE_URL,
          });
          await peer.connect();
          t.after(() => peer.end());
          const key = "Synthetic writer unseen removal";
          const removal = { ...remove(key, 0), revision: "unreadable" };
          assert.deepEqual((await write([removal])).rejected, [
            { index: 0, code: "invalid_change", hidden: true },
          ]);
          const id = await identity(primary, key);
          const older = { ...upsert(key, 1), revision: "2001-01-01T00:00:00Z" };
          const newer = { ...upsert(key, 2), revision: "9999-01-01T00:00:00Z" };
          const snapshot = { authoritativeSnapshot: true };
          await applyListingPage(peer, primary, [remove(key, 3)], snapshot);
          for (const replay of [older, newer]) {
            await applyListingPage(peer, primary, [replay]);
            await absent(id);
          }
          assert.deepEqual(
            (
              await applyListingPage(
                peer,
                primary,
                [{ ...older, revision: "unreadable" }],
                snapshot,
              )
            ).rejected,
            [{ index: 0, code: "invalid_change", hidden: true }],
          );
          await absent(id);
          await applyListingPage(peer, primary, [older], snapshot);
          assert.equal((await publicDetail(id)).body.data.id, id);
          assert.equal((await searchItem(id)).id, id);
          await applyListingPage(peer, primary, [remove(key, 4)]);
          await absent(id);
        },
      );

      await t.test(
        "an oversized indexed city cannot roll back a sibling removal",
        async () => {
          const badKey = "Synthetic writer oversized city";
          const removeKey = "Synthetic writer city sibling";
          await write([upsert(badKey, 1), upsert(removeKey, 1)]);
          const badId = await identity(primary, badKey);
          const siblingId = await identity(primary, removeKey);
          const bad = upsert(badKey, 2);
          bad.listing.source.Address!.city = randomBytes(8192).toString("hex");
          assert.deepEqual(
            (await write([bad, remove(removeKey, 2)])).rejected,
            [{ index: 0, code: "invalid_change", hidden: true }],
          );
          await absent(badId);
          await absent(siblingId);
        },
      );

      await t.test(
        "applying invalid configured disclosures preserves stored listings",
        async () => {
          const key = "Synthetic writer invalid disclosure";
          const cases = [
            { approvedFeedBlocks: [] },
            { approvedListingBlocks: [] },
            {
              approvedPageBlocks: [{ ...feed.approvedFeedBlocks[0], text: "" }],
            },
          ];
          await write([upsert(key, 1)]);
          const id = await identity(primary, key);
          const before = await stored(id);
          for (const blocks of cases) {
            await assert.rejects(applyNotices({ ...feed, ...blocks }));
            assert.deepEqual(await stored(id), before);
          }
        },
      );

      await t.test(
        "legacy long source keys can be reseeded, updated, and removed",
        async () => {
          const key = "Synthetic writer " + "x".repeat(1025);
          const record = structuredClone(fixtures.listings[0]);
          record.publicId = "lst_writer_legacy_key";
          record.source.ListingKey = key;
          await db.query(
            `WITH copied AS (
            INSERT INTO idx.listings
            SELECT (jsonb_populate_record(NULL::idx.listings, to_jsonb(l) || jsonb_build_object('id', $1::text))).*
            FROM idx.listings l WHERE id='lst_demo_0001'
            RETURNING id, source_updated_at
          )
          INSERT INTO idx.source_mappings (feed_id, source_key, listing_id, source_revision)
          SELECT $2, $3, id, source_updated_at FROM copied`,
            [record.publicId, primary, key],
          );
          record.source.ListPrice = "123000";
          await seed(db, { feeds: [], sites: [], listings: [record] });
          assert.equal((await stored(record.publicId))[0].price, "123000");
          const update = upsert(key, 1);
          update.listing.source.ListPrice = "124000";
          assert.deepEqual((await write([update])).rejected, []);
          assert.equal(
            (await publicDetail(record.publicId)).body.data.price.amount,
            "124000",
          );
          assert.equal(
            (await searchItem(record.publicId)).price?.amount,
            "124000",
          );
          await write([remove(key, 2)]);
          await absent(record.publicId);
        },
      );

      await t.test(
        "two restricted writers serialize concurrent pages for the same feed",
        async (t) => {
          const peer = new pg.Client({
            connectionString: process.env.LISTING_WRITER_DATABASE_URL,
          });
          await peer.connect();
          t.after(() => peer.end());
          const key = "Synthetic writer concurrent updates";
          await write([upsert(key, 1)]);
          const id = await identity(primary, key);
          const peerPid = (await peer.query("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          let committing!: () => void;
          let release!: () => void;
          const commit = new Promise<void>((resolve) => {
            committing = resolve;
          });
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          const query = writer.query.bind(writer);
          t.mock.method(
            writer,
            "query",
            async (sql: string, values?: unknown[]) => {
              if (sql === "COMMIT") {
                committing();
                await released;
              }
              return query(sql, values);
            },
          );
          const first = write([remove(key, 3)]);
          await Promise.race([commit, first]);
          const second = applyListingPage(peer, primary, [upsert(key, 2)]);
          try {
            let waiting = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const result = await db.query(
                "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                [peerPid],
              );
              if (result.rowCount) {
                waiting = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(waiting, "The second writer must wait on the feed lock");
            await publicDetail(id);
          } finally {
            release();
            await Promise.all([first, second]);
          }
          await absent(id);
        },
      );
    },
  );
  await t.test(
    "anonymous discovery advertises only implemented capabilities and exact release contract",
    async () => {
      const { body } = await request("/api", 200, null);
      assert.equal(body.data.engineVersion, "0.1.0");
      assert.deepEqual(body.data.supportedVersions, [
        {
          major: "v1",
          contractVersion: "1.0.0",
          capabilities: [
            "listingSearch",
            "listingDetail",
            "displayRulesV1",
            "inquiryCreate",
            "inquiryReceipt",
          ],
        },
      ]);
      assert.deepEqual(
        (await request("/api/v1/openapi.json", 200, null)).body,
        contract,
      );
    },
  );
  await t.test(
    "detail translates facts, ordered display and feed freshness without private columns",
    async () => {
      const good = await request(listing);
      assert.equal(good.body.data.id, "lst_demo_0001");
      assert.deepEqual(good.body.data.price, {
        amount: "425000.00",
        currency: "USD",
      });
      assert.equal(good.body.data.bedrooms, 1);
      assert.equal(good.body.data.synthetic, true);
      assert.equal(good.body.data.display.blocks[0].id, "synthetic_broker");
      assert.equal(good.body.display.blocks[0].id, "synthetic_notice");
      assert.equal(
        good.body.data.display.freshness.refreshedAt,
        "2026-11-01T00:00:00.000Z",
      );
      assert.deepEqual(
        Object.keys(good.body.data).sort(),
        [
          "id",
          "synthetic",
          "status",
          "price",
          "address",
          "bedrooms",
          "images",
          "withheldFields",
          "display",
        ].sort(),
      );
      assert.equal(
        good.response.headers.get("Cache-Control"),
        "private, no-store",
      );
      const closed = await request("/api/v1/listings/lst_demo_0003");
      assert.equal(closed.body.data.status, "closed");
      assert.deepEqual(
        closed.body.display.blocks.map((block: DisplayBlock) => block.id),
        ["synthetic_notice", "closed_information"],
      );
    },
  );
  await t.test(
    "required-fact negative control and required-header controls reject broken responses",
    async () => {
      const good = await request(listing);
      const broken = structuredClone(good.body);
      delete broken.data.price;
      assert.throws(
        () => validateResponse(detailPath, good.response, broken),
        /required/,
      );
      for (const header of ["Request-Id", "Cache-Control"]) {
        const headers = new Headers(good.response.headers);
        headers.delete(header);
        assert.throws(
          () =>
            validateResponse(
              detailPath,
              new Response(null, { headers }),
              good.body,
            ),
          /Required header/,
        );
      }
    },
  );
  await t.test("unsupported display rules suppress the listing", async () => {
    await db.query(
      "UPDATE idx.feeds SET rules_version='2' WHERE id='feed_demo_primary'",
    );
    const result = await request(listing, 503);
    assert.equal(result.body.code, "display_rules_unavailable");
    await db.query(
      "UPDATE idx.feeds SET rules_version='1' WHERE id='feed_demo_primary'",
    );
  });
  await t.test(
    "drift check rejects a removed fact and passes the real response",
    async (t) => {
      const good = await request(listing);
      const drifted = structuredClone(good.body);
      delete drifted.data.price;
      assert.throws(
        () => validateResponse(detailPath, good.response, drifted),
        /required/,
      );
      t.diagnostic("Drifted copy: FAIL as expected (required price removed).");
      validateResponse(detailPath, good.response, good.body);
      t.diagnostic("Real response: PASS.");
    },
  );
  await t.test(
    "fixture ingestion removes property photos and redacts withheld addresses in disclosures",
    async () => {
      const fixtures = await new FixtureConnector().read();
      const unsafe = structuredClone(fixtures);
      const record = unsafe.listings[1];
      const street = "---";
      record.source.Address!.line1 = street;
      const hidden = "/api/v1/listings/lst_demo_0002";
      const visibleStreet = unsafe.listings[0].source.Address!.line1;
      unsafe.listings[0].source.Images![0].alt = `Synthetic illustration of ${visibleStreet}`;
      const block = (id: string) => ({
        id,
        text: `Listed by Synthetic Example Brokerage. ${street}.`,
        placement: "pageFooter",
        prominence: "normal",
        image: {
          url: "/media/synthetic-house-002.svg",
          alt: `Synthetic icon for ${street.toUpperCase()}`,
        },
      });
      record.source.Images![0].alt = `Synthetic illustration of ${street.toUpperCase()}`;
      record.blocks.push(block("listing_address"));
      record.pageBlocks.push(block("page_address"));
      unsafe.feeds[0].blocks.push(block("feed_address"));
      try {
        await seed(db, unsafe);
        const { body, text } = await request(hidden);
        assert.equal(body.data.address, null);
        assert.deepEqual(body.data.withheldFields, ["address"]);
        assert.ok(!text.toLowerCase().includes(street.toLowerCase()));
        assert.deepEqual(body.data.images, []);
        for (const [blocks, id] of [
          [body.data.display.blocks, "listing_address"],
          [body.display.blocks, "feed_address"],
          [body.display.blocks, "page_address"],
        ] as const) {
          const disclosure = blocks.find(
            (item: DisplayBlock) => item.id === id,
          );
          assert.equal(
            disclosure.text,
            "Listed by Synthetic Example Brokerage. Address withheld.",
          );
          assert.equal(
            disclosure.image.alt,
            "Synthetic icon for Address withheld",
          );
          assert.equal(disclosure.image.url, "/media/synthetic-house-002.svg");
        }
        // Shared feed disclosures must also be safe when another listing is requested.
        const visible = await request(listing);
        assert.ok(!visible.text.toLowerCase().includes(street.toLowerCase()));
        assert.equal(
          visible.body.data.images[0].alt,
          `Synthetic illustration of ${visibleStreet}`,
        );
        for (const table of ["listings", "feeds"]) {
          const stored = (await db.query(`SELECT * FROM idx.${table}`)).rows;
          assert.ok(
            !JSON.stringify(stored)
              .toLowerCase()
              .includes(street.toLowerCase()),
          );
        }
      } finally {
        await seed(db, fixtures);
      }
    },
  );
  await t.test(
    "encoded disclosure image addresses reject ingestion and preserve safe rows and HTTP responses",
    async () => {
      const fixtures = await new FixtureConnector().read();
      const safe = structuredClone(fixtures);
      const hidden = "/api/v1/listings/lst_demo_0002";
      const street = safe.listings[1].source.Address!.line1;
      const asset = "/media/synthetic-house-002.svg";
      const safeUrl = `${asset}?label=%53ynthetic+house&size=2#illustration`;
      const block = () => ({
        id: "safe_media",
        text: "Synthetic disclosure.",
        placement: "pageFooter",
        prominence: "normal",
        image: { url: safeUrl, alt: "Synthetic illustration" },
      });
      safe.listings[1].blocks.push(block());
      safe.listings[1].pageBlocks.push(block());
      safe.feeds[0].blocks.push(block());
      const media = (input: typeof safe) => [
        input.listings[1].blocks.at(-1)!.image!,
        input.listings[1].pageBlocks.at(-1)!.image!,
        input.feeds[0].blocks.at(-1)!.image!,
      ];
      const rows = async () => ({
        listings: (await db.query("SELECT * FROM idx.listings ORDER BY id"))
          .rows,
        feeds: (await db.query("SELECT * FROM idx.feeds ORDER BY id")).rows,
      });
      try {
        await seed(db, safe);
        const stored = await rows();
        const hiddenBody = (await request(hidden)).body;
        const visibleBody = (await request(listing)).body;
        assert.equal(hiddenBody.data.display.blocks.at(-1).image.url, safeUrl);
        assert.deepEqual(
          hiddenBody.display.blocks
            .filter((item: DisplayBlock) => item.id === "safe_media")
            .map((item: DisplayBlock) => item.image!.url),
          [safeUrl, safeUrl],
        );
        assert.equal(
          visibleBody.display.blocks.find(
            (item: DisplayBlock) => item.id === "safe_media",
          ).image.url,
          safeUrl,
        );
        const encoded = encodeURIComponent(street);
        const escapedLetter = encoded.replace("Hidden", "%48idden");
        const references = [
          `/media/${street}.svg`,
          `/media/${encoded}.svg`,
          `/media/${escapedLetter}.svg`,
          `/media/${escapedLetter}/../synthetic-house-002.svg`,
          `${asset}?address=${encoded.replaceAll("%20", "+")}`,
          `${asset}?address=${escapedLetter.replaceAll("%20", "+")}`,
          `${asset}?address=${escapedLetter}`,
          `${asset}?${escapedLetter}=illustration`,
          `${asset}#${escapedLetter}`,
          `https://synthetic.example.invalid/media/${escapedLetter}.svg`,
          `${asset}?address=%ZZ`,
        ];
        for (const reference of references) {
          for (let target = 0; target < 3; target++) {
            const attempt = structuredClone(safe);
            media(attempt)[target].url = reference;
            // Stage observable writes before each rejection, including shared-feed rejection.
            attempt.feeds.forEach((feed) => {
              feed.blocks[0].text = "Synthetic staged rollback marker.";
            });
            attempt.feeds.reverse();
            attempt.listings[0].source.StandardStatus = "pending";
            await assert.rejects(
              seed(db, attempt),
              /Withheld address in media reference/,
            );
            assert.deepEqual(await rows(), stored);
            assert.deepEqual((await request(hidden)).body, hiddenBody);
            assert.deepEqual((await request(listing)).body, visibleBody);
          }
        }
      } finally {
        await seed(db, fixtures);
      }
    },
  );
  await t.test(
    "null facts and withholding names have distinct meanings; hidden address is absent everywhere",
    async () => {
      const { body, text } = await request("/api/v1/listings/lst_demo_0002");
      assert.equal(body.data.address, null);
      assert.equal(body.data.bedrooms, null);
      assert.deepEqual(body.data.withheldFields, ["address"]);
      for (const name of body.data.withheldFields)
        assert.equal(body.data[name], null);
      const fixtures = JSON.parse(
        await readFile(
          new URL("../../fixtures/listings.json", import.meta.url),
          "utf8",
        ),
      );
      assert.ok(!text.includes(fixtures[1].source.Address.line1));
      assert.equal(
        (await request("/api/v1/listings/lst_demo_0004")).body.data.price,
        null,
      );
      await db.query(
        "UPDATE idx.listings SET status=NULL, price=NULL, currency=NULL, address=NULL, bedrooms=NULL, images=NULL WHERE id='lst_demo_0001'",
      );
      const nullable = await request(listing);
      for (const fact of ["status", "price", "address", "bedrooms", "images"])
        assert.equal(nullable.body.data[fact], null);
      assert.deepEqual(nullable.body.data.withheldFields, []);
    },
  );
  await t.test(
    "missing, withdrawn and wrong-Site reads have identical generic problem content",
    async () => {
      const missing = await request(
        "/api/v1/listings/unknown-input-marker",
        404,
      );
      const withdrawn = await request("/api/v1/listings/lst_demo_0006", 404);
      const wrongSite = await request(listing, 404, other.secret);
      for (const item of [withdrawn, wrongSite])
        assert.deepEqual(
          { ...item.body, requestId: "" },
          { ...missing.body, requestId: "" },
        );
      assert.ok(!missing.text.includes("unknown-input-marker"));
      await db.query(
        "UPDATE idx.listings SET entire_listing_display=false WHERE id='lst_demo_0001'",
      );
      await request(listing, 404);
      await db.query(
        "UPDATE idx.listings SET entire_listing_display=true WHERE id='lst_demo_0001'",
      );
      assert.equal(
        (await request("/api/v1/listings/lst_demo_0024", 503, other.secret))
          .body.code,
        "feed_expired",
      );
    },
  );
  await t.test(
    "missing, invalid and revoked keys; missing scope; Origin on secret requests",
    async () => {
      await request(listing, 401, null);
      await request(listing, 401, "invalid-secret-marker");
      await request(listing, 403, limited.secret);
      await request(listing, 403, key.secret, {
        headers: { Origin: "https://synthetic.example.invalid" },
      });
      await request("/api", 403, key.secret, { headers: { Origin: "null" } });
      await keyCommand(directory, "revoke", limited.id);
      await request(listing, 401, limited.secret);
      const row = (
        await db.query("SELECT * FROM idx.site_secret_keys WHERE id=$1", [
          key.id,
        ])
      ).rows[0];
      assert.equal(row.site_id, "site_demo_primary");
      assert.deepEqual(row.scopes, ["listings:read"]);
      assert.ok(
        row.secret_hash ===
          createHash("sha256").update(key.secret).digest("hex"),
      );
      assert.ok(!JSON.stringify(row).includes(key.secret));
    },
  );
  await t.test(
    "key files are written once; failed rotation rolls back; rotation binds to the same Site",
    async () => {
      const rows = async () =>
        Number(
          (await db.query("SELECT count(*) FROM idx.site_secret_keys")).rows[0]
            .count,
        );
      const before = await rows();
      await assert.rejects(
        keyCommand(directory, "rotate", key.id, "listings:read", "create"),
      );
      assert.equal(await rows(), before);
      await request(listing);
      const rotated = await keyCommand(
        directory,
        "rotate",
        key.id,
        "listings:read",
      );
      secrets.push(rotated.secret);
      assert.ok(rotated.secret !== key.secret);
      assert.ok((await readFile(key.path, "utf8")).trim() === key.secret);
      await request(listing, 200, rotated.secret);
      await request(listing, 401, key.secret);
      const records = (
        await db.query(
          "SELECT site_id, revoked_at FROM idx.site_secret_keys WHERE id=ANY($1)",
          [[key.id, rotated.id]],
        )
      ).rows;
      assert.ok(records.every((row) => row.site_id === "site_demo_primary"));
      assert.equal(records.filter((row) => row.revoked_at !== null).length, 1);
      await assert.rejects(
        keyCommand(directory, "create", "site_demo_primary", "admin", "bad"),
      );
    },
  );
  await t.test(
    "version routing, unknown paths, all unsupported methods and unknown/oversized queries",
    async () => {
      assert.equal(
        (await request("/api/listings/input-marker", 400)).body.code,
        "api_version_required",
      );
      assert.equal(
        (await request("/api/v9/listings/input-marker", 404)).body.code,
        "api_version_unsupported",
      );
      assert.equal(
        (await request("/api/v1/input-marker", 404)).body.code,
        "not_found",
      );
      await request("/api/v1/listings");
      for (const path of ["/api", "/api/v1/openapi.json", listing]) {
        for (const method of [
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "OPTIONS",
          "HEAD",
        ]) {
          assert.equal(
            (
              await request(path, 405, key.secret, {
                method,
                ...(method === "POST" ? { body: "body-private-marker" } : {}),
              })
            ).response.headers.get("Allow"),
            "GET",
          );
        }
        for (const query of [
          "?unknown=query-private-marker",
          "?unknown=a&unknown=b",
          `?${"x".repeat(2048)}`,
          `?${"x".repeat(2049)}`,
        ]) {
          const result = await request(path + query, 400);
          assert.equal(result.body.code, "invalid_query");
          assert.ok(!result.text.includes("query-private-marker"));
        }
      }
    },
  );
  await t.test(
    "open country/currency, decimal precision and safe-integer bedroom schema controls",
    async () => {
      const good = await request(listing);
      const sample = structuredClone(good.body);
      sample.data.address.country = "CA";
      sample.data.price = { amount: "123.456", currency: "CAD" };
      sample.data.bedrooms = Number.MAX_SAFE_INTEGER;
      validateResponse(detailPath, good.response, sample);
      sample.data.bedrooms += 1;
      assert.throws(
        () => validateResponse(detailPath, good.response, sample),
        /maximum/,
      );
      valid("/components/schemas/Money", {
        amount: "0.001",
        currency: "KWD",
      });
      await db.query(
        "UPDATE idx.listings SET bedrooms=9007199254740991 WHERE id='lst_demo_0001'",
      );
      assert.equal(
        (await request(listing)).body.data.bedrooms,
        Number.MAX_SAFE_INTEGER,
      );
      await assert.rejects(
        db.query(
          "UPDATE idx.listings SET bedrooms=9007199254740992 WHERE id='lst_demo_0001'",
        ),
        { code: "23514" },
      );
    },
  );
  await t.test(
    "stderr contains exactly one redacted structured record per request",
    async () => {
      // Fetch may resolve before the stderr pipe delivers its final chunk.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const text = engine.logs();
      for (const secret of [
        ...secrets,
        "query-private-marker",
        "body-private-marker",
        "input-marker",
        "invalid-secret-marker",
        "untrusted-request-id",
      ])
        assert.ok(!text.includes(secret));
      const logs = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((line) => line.requestId);
      assert.equal(logs.length, requests.length);
      for (const request of requests) {
        const log = logs.find((line) => line.requestId === request.id);
        assert.ok(log);
        assert.equal(log.status, request.status);
        assert.equal(log.code, request.code);
        assert.equal(log.engineRelease, "0.1.0");
        assert.equal(typeof log.duration, "number");
        assert.ok(log.duration >= 0);
        assert.equal(new Date(log.timestamp).toISOString(), log.timestamp);
        assert.deepEqual(
          Object.keys(log)
            .filter(
              (name) =>
                ![
                  "errorType",
                  "errorCode",
                  "operation",
                  "message",
                  "stack",
                ].includes(name),
            )
            .sort(),
          [
            "method",
            "route",
            "status",
            "code",
            "duration",
            "requestId",
            "engineRelease",
            "timestamp",
            ...(log.keyId === undefined ? [] : ["keyId"]),
          ].sort(),
        );
        assert.ok(
          [
            "/api",
            "/api/*",
            "/api/v1/openapi.json",
            "/api/v1/listings",
            detailPath,
          ].includes(log.route),
        );
      }
    },
  );
});
