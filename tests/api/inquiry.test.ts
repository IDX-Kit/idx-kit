import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pg from "pg";
import canonicalize from "canonicalize";
import type { InquiryInput } from "@idx-kit/client";
import { registerSecret } from "../logs.ts";
import { workerRuntime } from "../workers/runtime.ts";
import { execute, keyCommand, startEngine } from "./runtime.ts";
import { valid, validateResponse } from "./contract.ts";

const path = "/api/v1/inquiries";
const receiptPath = path + "/{inquiryId}";
const site = "site_demo_primary";
// All visitors and messages in this suite are invented test data.
const input: InquiryInput = {
  listingId: "lst_demo_0001",
  visitor: {
    name: "Invented Inquiry Visitor",
    email: "inquiry@example.invalid",
  },
  message: "Synthetic inquiry privacy marker. Is a test showing available?",
  context: {
    pagePath: "/properties/lst_demo_0001",
    landingPagePath: "/guides/example-springs",
    campaign: "synthetic",
    source: "guide",
    medium: "internal",
  },
};
const hashBody = (body: InquiryInput) =>
  createHash("sha256").update(canonicalize(body)!).digest("hex");

test(
  "durable inquiry acceptance through HTTP",
  { timeout: 150_000 },
  async (t) => {
    const directory = await mkdtemp(`${tmpdir()}/idx-inquiry-`);
    let db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const originalIds = (
      await db.query("SELECT id FROM idx.inquiries")
    ).rows.map((row) => row.id);
    const main = await keyCommand(
      directory,
      "create",
      site,
      "inquiries:write,inquiries:read",
      "main",
    );
    const other = await keyCommand(
      directory,
      "create",
      "site_demo_other",
      "inquiries:write,inquiries:read",
      "other",
    );
    const listingKey = await keyCommand(
      directory,
      "create",
      site,
      "listings:read",
      "listing",
    );
    const writeKey = await keyCommand(
      directory,
      "create",
      site,
      "inquiries:write",
      "write",
    );
    const readKey = await keyCommand(
      directory,
      "create",
      site,
      "inquiries:read",
      "read",
    );
    const privateValues = [
      input.visitor.name,
      input.visitor.email,
      input.message,
      hashBody(input),
    ];
    privateValues.forEach(registerSecret);
    const logs: string[] = [];
    let engine = await startEngine();
    async function stopEngine() {
      await engine.stop();
      logs.push(engine.logs());
    }
    t.after(async () => {
      await stopEngine();
      await db.query(
        "UPDATE idx.listings SET entire_listing_display=true WHERE id=$1",
        [input.listingId],
      );
      await db.query("DELETE FROM idx.inquiries WHERE NOT (id=ANY($1))", [
        originalIds,
      ]);
      await db.query("DELETE FROM idx.site_secret_keys WHERE id=ANY($1)", [
        createdKeyIds,
      ]);
      await db.end();
      await rm(directory, { recursive: true, force: true });
    });
    let currentWriteSecret = writeKey.secret;
    const createdKeyIds = [
      main.id,
      other.id,
      listingKey.id,
      writeKey.id,
      readKey.id,
    ];
    const requests: { id: string; status: number; route: string }[] = [];
    const requestIds = new Set<string>();
    async function request(
      target = path,
      init: RequestInit = {},
      status = 201,
      secret: string | null = main.secret,
    ) {
      const headers = new Headers(init.headers);
      if (secret !== null) headers.set("Authorization", `Bearer ${secret}`);
      headers.set("Request-Id", "untrusted-inquiry-request-id");
      const response = await fetch(`http://127.0.0.1:8787${target}`, {
        ...init,
        headers,
      });
      assert.equal(response.status, status);
      const text = await response.text();
      const body = init.method === "HEAD" ? undefined : JSON.parse(text);
      const route = target.startsWith(path + "/")
        ? receiptPath
        : target.startsWith("/api/v1/listings/")
          ? "/api/v1/listings/{listingId}"
          : target;
      validateResponse(
        route,
        response,
        body,
        init.method === "HEAD",
        init.method === "POST" && route === path ? "post" : "get",
      );
      const id = response.headers.get("Request-Id")!;
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.ok(!requestIds.has(id));
      requestIds.add(id);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      if (status >= 400 && body) {
        assert.equal(body.status, status);
        assert.equal(body.requestId, id);
      }
      for (const value of privateValues) assert.ok(!text.includes(value));
      requests.push({ id, status, route });
      return { response, body };
    }
    function actionKey() {
      const key = `"${randomUUID()}"`;
      privateValues.push(key, key.slice(1, -1));
      registerSecret(key.slice(1, -1));
      return key;
    }
    function post(
      key: string | null,
      body: unknown = input,
      headers: HeadersInit = {},
    ) {
      const result = new Headers(headers);
      result.set("Content-Type", "application/json");
      if (key !== null) result.set("Idempotency-Key", key);
      return { method: "POST", headers: result, body: JSON.stringify(body) };
    }
    async function rows(key: string) {
      return (
        await db.query(
          "SELECT * FROM idx.inquiries WHERE site_id=$1 AND idempotency_key=$2",
          [site, key],
        )
      ).rows;
    }
    async function waitForLock(count = 1) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await db.query(
          "SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'relation')",
        );
        if (result.rowCount !== null && result.rowCount >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(
        "The request must reach a database lock before it is released.",
      );
    }
    const key = actionKey();
    const first = await request(path, post(key));
    const location = first.response.headers.get("Location")!;
    assert.equal(location, `${path}/${first.body.data.id}`);
    assert.match(first.body.data.id, /^inq_[A-Za-z0-9_-]+$/);
    assert.deepEqual(Object.keys(first.body).sort(), ["data", "meta"]);
    assert.deepEqual(Object.keys(first.body.data).sort(), ["id", "receivedAt"]);

    await t.test(
      "create, read, replay and canonical property order return one receipt",
      async () => {
        assert.deepEqual((await request(location, {}, 200)).body, first.body);
        assert.deepEqual((await request(path, post(key))).body, first.body);
        const reordered = {
          context: Object.fromEntries(Object.entries(input.context).reverse()),
          message: input.message,
          visitor: { email: input.visitor.email, name: input.visitor.name },
          listingId: input.listingId,
        };
        const init = post(key, reordered);
        init.body = JSON.stringify(reordered, null, 2);
        const replay = await request(path, init);
        assert.deepEqual(replay.body, first.body);
        assert.equal(replay.response.headers.get("Location"), location);
        const stored = await rows(key);
        assert.equal(stored.length, 1);
        assert.equal(stored[0].body_hash, hashBody(input));
        assert.equal(stored[0].visitor_name, input.visitor.name);
        assert.equal(stored[0].visitor_email, input.visitor.email);
        assert.equal(stored[0].message, input.message);
        assert.deepEqual(stored[0].context, input.context);
        const negative = structuredClone(first.body);
        delete negative.data.receivedAt;
        assert.throws(() =>
          validateResponse(path, first.response, negative, false, "post"),
        );
      },
    );
    await t.test(
      "a changed body is refused without changing the original row",
      async () => {
        const before = await rows(key);
        const result = await request(
          path,
          post(key, { ...input, message: "Different synthetic message" }),
          422,
        );
        assert.equal(result.body.code, "idempotency_mismatch");
        assert.deepEqual(await rows(key), before);
      },
    );
    await t.test(
      "aged receipts replay before listing visibility checks, without changing key or hash",
      async () => {
        const agedKey = actionKey();
        const created = await request(path, post(agedKey));
        await db.query(
          "UPDATE idx.inquiries SET received_at='2001-01-01T00:00:00Z' WHERE id=$1",
          [created.body.data.id],
        );
        const before = await rows(agedKey);
        await db.query(
          "UPDATE idx.listings SET entire_listing_display=false WHERE id=$1",
          [input.listingId],
        );
        try {
          const replay = await request(path, post(agedKey));
          assert.deepEqual(replay.body.data, {
            id: before[0].id,
            receivedAt: before[0].received_at.toISOString(),
          });
          assert.equal(
            replay.response.headers.get("Location"),
            created.response.headers.get("Location"),
          );
          assert.deepEqual(await rows(agedKey), before);
          assert.deepEqual((await request(path, post(key))).body, first.body);
          await request(path, post(actionKey()), 404);
          assert.equal(
            (
              await request(
                path,
                post(key, { ...input, message: "Changed synthetic body" }),
                422,
              )
            ).body.code,
            "idempotency_mismatch",
          );
        } finally {
          await db.query(
            "UPDATE idx.listings SET entire_listing_display=true WHERE id=$1",
            [input.listingId],
          );
        }
        for (const listingId of ["lst_missing_synthetic", "lst_demo_0006"])
          await request(path, post(actionKey(), { ...input, listingId }), 404);
        await request(path, post(actionKey()), 404, other.secret);
        await request(location, {}, 404, other.secret);
        await request(path + "/inq_missing_synthetic", {}, 404);
      },
    );
    await t.test(
      "parallel duplicates wait at INSERT then return one receipt; changed competitors get 422",
      async () => {
        for (const different of [false, true]) {
          const concurrentKey = actionKey();
          const blocker = new pg.Client({
            connectionString: process.env.DATABASE_URL,
          });
          await blocker.connect();
          await blocker.query("BEGIN");
          await blocker.query("LOCK TABLE idx.inquiries IN SHARE MODE");
          const bodies = Array.from({ length: 4 }, (_, i) =>
            different
              ? { ...input, message: `Synthetic competitor ${i}` }
              : input,
          );
          // Validate the status once the race has selected a winner.
          const pending = bodies.map(async (body) => {
            const response = await fetch(`http://127.0.0.1:8787${path}`, {
              ...post(concurrentKey, body),
              headers: {
                ...Object.fromEntries(post(concurrentKey, body).headers),
                Authorization: `Bearer ${main.secret}`,
              },
            });
            const result = await response.json();
            validateResponse(path, response, result, false, "post");
            assert.equal(response.headers.get("Cache-Control"), "no-store");
            assert.match(response.headers.get("Request-Id")!, /^[0-9a-f-]{36}$/);
            requests.push({
              id: response.headers.get("Request-Id")!,
              status: response.status,
              route: path,
            });
            return { response, body: result };
          });
          try {
            await waitForLock(4);
          } finally {
            await blocker.query("ROLLBACK");
            await blocker.end();
          }
          const results = await Promise.all(pending);
          const accepted = results.filter(
            (item) => item.response.status === 201,
          );
          assert.equal(accepted.length, different ? 1 : 4);
          assert.equal(
            new Set(accepted.map((item) => item.body.data.id)).size,
            1,
          );
          for (const item of accepted)
            assert.deepEqual(item.body, accepted[0].body);
          for (const item of results.filter(
            (item) => item.response.status !== 201,
          )) {
            assert.equal(item.response.status, 422);
            assert.equal(item.body.code, "idempotency_mismatch");
          }
          assert.equal((await rows(concurrentKey)).length, 1);
        }
      },
    );
    await t.test(
      "an uncommitted key rollback lets the waiting insert succeed; timeout is 503 and retry succeeds",
      async () => {
        for (const timeout of [false, true]) {
          const blockedKey = actionKey();
          const blocker = new pg.Client({
            connectionString: process.env.DATABASE_URL,
          });
          await blocker.connect();
          await blocker.query("BEGIN");
          await blocker.query(
            `INSERT INTO idx.inquiries (id,site_id,listing_id,visitor_name,visitor_email,message,context,idempotency_key,body_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              `inq_${randomUUID()}`,
              site,
              input.listingId,
              input.visitor.name,
              input.visitor.email,
              input.message,
              JSON.stringify(input.context),
              blockedKey,
              hashBody(input),
            ],
          );
          const waiting = request(path, post(blockedKey), timeout ? 503 : 201);
          let result;
          try {
            await waitForLock();
            if (timeout) {
              result = await waiting;
              assert.equal(result.body.code, "service_unavailable");
              assert.equal((await rows(blockedKey)).length, 0);
            }
          } finally {
            await blocker.query("ROLLBACK");
            await blocker.end();
          }
          if (!timeout) await waiting;
          await request(path, post(blockedKey));
          assert.equal((await rows(blockedKey)).length, 1);
        }
      },
    );
    await t.test(
      "API-key replacement preserves the Site's receipt and replay",
      async () => {
        const rotated = await keyCommand(
          directory,
          "rotate",
          writeKey.id,
          "inquiries:write",
          "rotated",
        );
        createdKeyIds.push(rotated.id);
        currentWriteSecret = rotated.secret;
        await request(path, post(key), 401, writeKey.secret);
        assert.deepEqual(
          (await request(path, post(key), 201, rotated.secret)).body,
          first.body,
        );
        assert.deepEqual(
          (await request(location, {}, 200, readKey.secret)).body,
          first.body,
        );
        assert.equal((await rows(key)).length, 1);
      },
    );
    await t.test(
      "authentication and scopes are enforced separately on every route",
      async () => {
        for (const [target, init] of [
          [path, post(key)],
          [location, {}],
        ] as const) {
          await request(target, init, 401, null);
          await request(target, init, 401, "invalid-inquiry-secret-marker");
          await request(target, init, 403, listingKey.secret);
          const headers = new Headers(init.headers);
          headers.set("Origin", "https://synthetic.example.invalid");
          await request(target, { ...init, headers }, 403);
        }
        await request(path, post(key), 403, readKey.secret);
        await request(location, {}, 403, currentWriteSecret);
        for (const target of [
          "/api/v1/listings",
          "/api/v1/listings/lst_demo_0001",
        ])
          await request(target, {}, 403, main.secret);
        await keyCommand(directory, "revoke", readKey.id);
        await request(location, {}, 401, readKey.secret);
        await request(path, post(key), 401, readKey.secret);
        await request(path, post(null, {}), 401, null);
      },
    );
    await t.test(
      "header, media type, body size, malformed JSON and each field are validated",
      async () => {
        for (const bad of [
          null,
          "",
          randomUUID(),
          '"not-a-uuid"',
          '"00000000-0000-1000-8000-000000000000"',
          '"00000000-0000-4000-7000-000000000000"',
        ])
          await request(path, post(bad), 400);
        for (const contentType of [
          null,
          "text/plain",
          "application/x-www-form-urlencoded",
        ]) {
          const init = post(actionKey());
          if (contentType === null) init.headers.delete("Content-Type");
          else init.headers.set("Content-Type", contentType);
          await request(path, init, 415);
        }
        const malformed = post(actionKey());
        malformed.body = '{"visitor":';
        await request(path, malformed, 400);
        await request(
          path,
          post(actionKey(), { ...input, message: "x".repeat(17 * 1024) }),
          413,
        );
        // No Content-Length: Hono must also enforce the bound on streamed bodies.
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(17 * 1024)));
            controller.close();
          },
        });
        await request(
          path,
          { ...post(actionKey()), body: stream, duplex: "half" } as RequestInit,
          413,
        );
        const cases: [string[], unknown][] = [
          [["listingId"], ""],
          [["listingId"], "invalid/id"],
          [["visitor", "name"], ""],
          [["visitor", "name"], "x".repeat(101)],
          [["visitor", "email"], "invalid-email"],
          [["visitor", "email"], "x".repeat(255) + "@example.invalid"],
          [["message"], ""],
          [["message"], "x".repeat(4001)],
          [["context", "pagePath"], "/invalid?query"],
          [["context", "pagePath"], "/" + "x".repeat(256)],
          [["context", "landingPagePath"], "https://example.invalid"],
          ...["campaign", "source", "medium"].flatMap(
            (name): [string[], unknown][] => [
              [["context", name], "invalid token"],
              [["context", name], "x".repeat(65)],
            ],
          ),
        ];
        for (const [parts, value] of cases) {
          const body = structuredClone(input) as unknown as Record<
            string,
            unknown
          >;
          let parent = body;
          for (const part of parts.slice(0, -1))
            parent = parent[part] as Record<string, unknown>;
          parent[parts.at(-1)!] = value;
          const result = await request(path, post(actionKey(), body), 422);
          assert.ok(
            result.body.errors.some(
              (error: { pointer: string }) =>
                error.pointer === "/" + parts.join("/"),
            ),
          );
          assert.throws(() => valid("/components/schemas/InquiryInput", body));
        }
        for (const field of ["listingId", "visitor", "message", "context"]) {
          const body = { ...input } as Record<string, unknown>;
          delete body[field];
          const result = await request(path, post(actionKey(), body), 422);
          assert.ok(
            result.body.errors.some(
              (error: { pointer: string }) => error.pointer === "/" + field,
            ),
          );
        }
        for (const body of [
          { ...input, extra: true },
          { ...input, visitor: { ...input.visitor, extra: true } },
          { ...input, context: { ...input.context, extra: true } },
        ])
          await request(path, post(actionKey(), body), 422);
        await request(
          path,
          post(actionKey(), {
            ...input,
            context: { pagePath: input.context.pagePath },
          }),
        );
      },
    );
    await t.test(
      "unsupported methods return 405 with the proper Allow and discovery lists both operations",
      async () => {
        for (const target of [path, location]) {
          const allowed = target === path ? "POST" : "GET";
          for (const method of [
            "GET",
            "HEAD",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "OPTIONS",
          ].filter((method) => method !== allowed)) {
            const result = await request(target, { method }, 405);
            assert.equal(result.response.headers.get("Allow"), allowed);
          }
        }
        const discovery = await request("/api", {}, 200, null);
        for (const capability of ["inquiryCreate", "inquiryReceipt"])
          assert.ok(
            discovery.body.data.supportedVersions[0].capabilities.includes(
              capability,
            ),
          );
      },
    );
    await t.test(
      "engine restart preserves both read and same-key retry",
      async () => {
        await stopEngine();
        engine = await startEngine();
        assert.deepEqual((await request(location, {}, 200)).body, first.body);
        assert.deepEqual((await request(path, post(key))).body, first.body);
        assert.equal((await rows(key)).length, 1);
      },
    );
    await t.test(
      "database restart preserves the receipt and a stopped database accepts nothing",
      { skip: workerRuntime },
      async () => {
        const cluster = process.env.IDX_TEST_PG_DIR;
        assert.ok(cluster, "CI supplies its disposable PostgreSQL directory");
        await db.end();
        const outageKey = actionKey();
        await execute("/usr/lib/postgresql/18/bin/pg_ctl", [
          "-D",
          cluster,
          "-m",
          "fast",
          "-w",
          "stop",
        ]);
        try {
          await request(path, post(outageKey), 503);
          await request(location, {}, 503);
        } finally {
          await execute("/usr/lib/postgresql/18/bin/pg_ctl", [
            "-D",
            cluster,
            "-l",
            cluster + ".log",
            "-w",
            "start",
          ]);
          db = new pg.Client({ connectionString: process.env.DATABASE_URL });
          await db.connect();
        }
        assert.equal((await rows(outageKey)).length, 0);
        assert.deepEqual((await request(location, {}, 200)).body, first.body);
        assert.deepEqual((await request(path, post(key))).body, first.body);
        assert.equal((await rows(key)).length, 1);
        await request(path, post(outageKey));
        assert.equal((await rows(outageKey)).length, 1);
      },
    );
    await t.test(
      "runtime privileges are exactly SELECT and INSERT; constraints are immediate and indexed",
      async () => {
        const grants = await db.query(
          "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='idx' AND table_name='inquiries' AND grantee='idx_runtime'",
        );
        assert.deepEqual(grants.rows.map((row) => row.privilege_type).sort(), [
          "INSERT",
          "SELECT",
        ]);
        const constraint = await db.query(
          "SELECT condeferrable FROM pg_constraint WHERE conrelid='idx.inquiries'::regclass AND conname='inquiries_site_key'",
        );
        assert.equal(constraint.rows[0].condeferrable, false);
      },
    );
    await t.test(
      "every response has a correlated safe log; failure causes and canonical routes are retained",
      async () => {
        await stopEngine();
        // Start again so the common cleanup can stop a running engine.
        engine = await startEngine();
        const hashes = (
          await db.query("SELECT body_hash FROM idx.inquiries")
        ).rows.map((row) => row.body_hash);
        const text = logs.join("\n");
        for (const value of [
          ...privateValues,
          ...hashes,
          currentWriteSecret,
          main.secret,
          other.secret,
          listingKey.secret,
          writeKey.secret,
          readKey.secret,
          "invalid-inquiry-secret-marker",
          "untrusted-inquiry-request-id",
        ])
          assert.ok(!text.includes(value));
        assert.equal(new Set(requests.map((item) => item.id)).size, requests.length);
        const records = text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        for (const request of requests) {
          const matches = records.filter(
            (line) => line.requestId === request.id,
          );
          assert.equal(matches.length, 1);
          const record = matches[0];
          assert.equal(record.route, request.route);
          assert.equal(record.status, request.status);
          if (request.status >= 400) {
            assert.equal(typeof record.errorType, "string");
            assert.ok(Object.hasOwn(record, "errorCode"));
          }
        }
        assert.ok(
          records.some(
            (record) =>
              record.operation === "inquiry.insert" && record.status === 503,
          ),
        );
      },
    );
  },
);
