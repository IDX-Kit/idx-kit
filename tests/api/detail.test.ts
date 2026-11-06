import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pg from "pg";
import type { DisplayBlock } from "@idx-kit/client";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { contract, valid, validateResponse } from "./contract.ts";
import { execute, keyCommand, startEngine } from "./runtime.ts";

test("real HTTP listing and key acceptance", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(`${tmpdir()}/idx-api-`);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  db.on("error", () => {});
  await db.connect();
  t.after(async () => {
    await db.end();
    await rm(directory, { recursive: true, force: true });
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
    "inquiries:write,inquiries:read",
    "limited",
  );
  const secrets = [key.secret, other.secret, limited.secret];
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
  let good: Awaited<ReturnType<typeof request>>;
  await t.test(
    "anonymous discovery advertises only implemented capabilities and exact release contract",
    async () => {
      const { body } = await request("/api", 200, null);
      assert.equal(body.data.engineVersion, "0.1.0");
      assert.deepEqual(body.data.supportedVersions, [
        {
          major: "v1",
          contractVersion: "1.0.0",
          capabilities: ["listingSearch", "listingDetail", "displayRulesV1"],
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
      good = await request(listing);
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
    () => {
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
    "drift capability probe uses a real response and a removed-fact negative control",
    async () => {
      const capture = (body: unknown, headers = good.response.headers) => ({
        log: {
          version: "1.2",
          creator: { name: "IDX Kit", version: "1" },
          entries: [
            {
              request: {
                method: "GET",
                url: `http://127.0.0.1:8787${listing}`,
                headers: [],
                queryString: [],
              },
              response: {
                status: 200,
                headers: Array.from(headers, ([name, value]) => ({
                  name,
                  value,
                })),
                content: {
                  mimeType: "application/json",
                  text: JSON.stringify(body),
                },
              },
            },
          ],
        },
      });
      const missingFact = structuredClone(good.body);
      delete missingFact.data.price;
      const missingHeader = new Headers(good.response.headers);
      missingHeader.delete("Request-Id");
      const results = [];
      for (const [name, sample] of [
        ["valid", capture(good.body)],
        ["missing-fact", capture(missingFact)],
        ["missing-header", capture(good.body, missingHeader)],
      ] as const) {
        const file = `${directory}/${name}.har`;
        await writeFile(file, JSON.stringify(sample));
        const args = [
          "node_modules/@redocly/cli/bin/cli.js",
          "drift",
          file,
          "--api",
          "openapi/v1/openapi.yaml",
          "--rules",
          "schema-consistency",
          "--format",
          "json",
        ];
        const result = await execute(process.execPath, args).then(
          () => true,
          () => false,
        );
        results.push(result);
      }
      t.diagnostic(
        results[0] && !results[1] && !results[2]
          ? "Drift detects both negative controls; JSON Schema additionally checks every error path."
          : "Drift cannot prove all required response controls; pinned JSON Schema 2020-12 validation checks every response and required header.",
      );
    },
  );
  await t.test(
    "ingestion removes withheld addresses from image alt and every display context",
    async () => {
      const fixtures = await new FixtureConnector().read();
      const unsafe = structuredClone(fixtures);
      const record = unsafe.listings[1];
      const street = record.source.Address!.line1;
      const hidden = "/api/v1/listings/lst_demo_0002";
      const visibleStreet = unsafe.listings[0].source.Address!.line1;
      unsafe.listings[0].source.Images![0].alt = `Synthetic illustration of ${visibleStreet}`;
      const block = (id: string) => ({
        id,
        text: `Synthetic disclosure for ${street}.`,
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
        assert.equal(
          body.data.images[0].alt,
          "Synthetic illustration of Address withheld",
        );
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
            "Synthetic disclosure for Address withheld.",
          );
          assert.equal(
            disclosure.image.alt,
            "Synthetic icon for Address withheld",
          );
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
    "encoded media addresses reject ingestion and preserve safe rows and HTTP responses",
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
      safe.listings[1].source.Images![0].url = safeUrl;
      safe.listings[1].blocks.push(block());
      safe.listings[1].pageBlocks.push(block());
      safe.feeds[0].blocks.push(block());
      const media = (input: typeof safe) => [
        input.listings[1].source.Images![0],
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
        assert.equal(hiddenBody.data.images[0].url, safeUrl);
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
          for (let target = 0; target < 4; target++) {
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
      key.secret = rotated.secret;
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
      valid(contract.components.schemas.Money, {
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
    "stopped database is a safe 503 while discovery and contract remain available",
    async () => {
      assert.ok(
        process.env.IDX_TEST_PGDATA,
        "Only the disposable runner cluster may be stopped",
      );
      await execute("/usr/lib/postgresql/18/bin/pg_ctl", [
        "-D",
        process.env.IDX_TEST_PGDATA!,
        "-m",
        "fast",
        "-w",
        "stop",
      ]);
      const result = await request(listing, 503);
      assert.equal(result.body.code, "service_unavailable");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const failure = engine
        .logs()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((line) => line.requestId === result.body.requestId);
      assert.equal(failure.length, 1);
      assert.equal(failure[0].operation, "key.lookup");
      assert.equal(failure[0].errorCode, "ECONNREFUSED");
      assert.equal(typeof failure[0].errorType, "string");
      for (const value of [
        "postgres",
        "SELECT",
        "secret_hash",
        "ECONNREFUSED",
        "127.0.0.1",
        "idx_runtime",
      ])
        assert.ok(!result.text.includes(value));
      await request("/api", 200, null);
      await request("/api/v1/openapi.json", 200, null);
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
