import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import type { SearchResponse } from "@idx-kit/client";
import { repository } from "@idx-kit/engine/src/db/read.ts";
import { createApp } from "@idx-kit/engine/src/http/app.ts";
import { startWorker, workerRuntime } from "../workers/runtime.ts";
import { contract, validateResponse } from "./contract.ts";
import {
  keyCommand,
  preserveKeys,
  setListingRequestLimit,
  startEngine,
} from "./runtime.ts";

const search = "/api/v1/listings";
const detail = search + "/lst_demo_0001";
const detailSchema = search + "/{listingId}";
const site = "site_demo_primary";
const queryMarker = "Synthetic quota query marker";
const requestHeaders = (secret: string) => ({
  Authorization: `Bearer ${secret}`,
  "X-Forwarded-For": "192.0.2.56",
});

async function check(response: Response, path: string) {
  const body = await response.json();
  validateResponse(path, response, body);
  const id = response.headers.get("Request-Id");
  if (response.status >= 400) {
    assert.equal(body.requestId, id);
    assert.equal(body.status, response.status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(Object.keys(body).sort(), [
      "code",
      "detail",
      "requestId",
      "status",
      "title",
      "type",
    ]);
  }
  if (response.status === 200)
    assert.equal(response.headers.get("Retry-After"), null);
  return { response, body, id };
}

test("listing request budgets through HTTP", { timeout: 90_000 }, async (t) => {
  for (const path of [search, detailSchema])
    assert.ok(
      Object.hasOwn(contract.paths[path].get.responses, "429"),
      `GET ${path} must declare a 429 response`,
    );
  const directory = await mkdtemp(`${tmpdir()}/idx-listing-limit-`);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const restoreKeys = await preserveKeys(db);
  t.after(async () => {
    try {
      await restoreKeys();
    } finally {
      await db.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const key = await keyCommand(directory, "create", site, "listings:read");
  const peer = await keyCommand(
    directory,
    "create",
    site,
    "listings:read",
    "peer",
  );
  const engine = await startEngine();
  t.after(() => engine.stop());

  const read = (path: string, secret: string, port = 8787) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: requestHeaders(secret),
    });
  async function request(path: string, status: number, secret = key.secret) {
    const response = await read(path, secret);
    assert.equal(response.status, status);
    return check(
      response,
      path.startsWith(search + "/") ? detailSchema : search,
    );
  }
  async function windowFor(id = key.id) {
    const { rows } = await db.query<{
      window_start: Date;
      request_count: number;
      xmin: string;
      xmax: string;
    }>(
      "SELECT window_start, request_count, xmin::text, xmax::text FROM idx.listing_request_windows WHERE key_id = $1",
      [id],
    );
    return rows[0];
  }
  async function ceiling(id: string) {
    const { rows } = await db.query(
      "SELECT listing_request_limit FROM idx.site_secret_keys WHERE id = $1",
      [id],
    );
    return rows[0].listing_request_limit;
  }

  assert.equal(await ceiling(key.id), 60);
  await setListingRequestLimit(db, key.id, 3);
  const forbidden = await fetch(`http://127.0.0.1:8787${detail}`, {
    headers: {
      ...requestHeaders(key.secret),
      Origin: "https://synthetic.example.invalid",
    },
  });
  assert.equal(forbidden.status, 403);
  await check(forbidden, detailSchema);
  await request(detail, 401, "invalid-listing-key-marker");
  assert.equal(await windowFor(), undefined);

  const firstPage = search + "?limit=1";
  const first = await request(firstPage, 200);
  const cursor = (first.body as SearchResponse).meta.page.nextCursor;
  assert.ok(cursor);
  const firstWindow = await windowFor();
  await request(`${firstPage}&after=${encodeURIComponent(cursor)}`, 200);
  const admitted = await request(detail, 200);
  const spent = await windowFor();
  assert.equal(spent.request_count, 3);
  assert.notEqual(spent.xmin, firstWindow.xmin);
  const refused = await request(detail, 429);
  const refusedSearch = await request(
    search + "?city=" + encodeURIComponent(queryMarker),
    429,
  );
  assert.deepEqual(await windowFor(), spent);
  await request(detail, 200, peer.secret);
  assert.equal((await windowFor(peer.id)).request_count, 1);

  for (const elapsed of [20, 40]) {
    const seeded = await db.query<{ window_end: Date }>(
      `UPDATE idx.listing_request_windows
      SET window_start = clock_timestamp() - $2::integer * interval '1 second'
      WHERE key_id = $1
      RETURNING window_start + interval '60 seconds' AS window_end`,
      [key.id, elapsed],
    );
    const { response } = await request(detail, 429);
    const remaining = await db.query<{ seconds_left: number }>(
      "SELECT CEIL(EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())))::integer AS seconds_left",
      [seeded.rows[0].window_end],
    );
    const retryAfter = Number(response.headers.get("Retry-After"));
    const secondsLeft = remaining.rows[0].seconds_left;
    assert.ok(
      Math.abs(retryAfter - secondsLeft) <= 2,
      `Expected Retry-After within two seconds of ${secondsLeft}, got ${retryAfter}`,
    );
  }
  await db.query(
    "UPDATE idx.listing_request_windows SET window_start = clock_timestamp() - interval '61 seconds' WHERE key_id = $1",
    [key.id],
  );
  const expired = await windowFor();
  await request(detail, 200);
  const restarted = await windowFor();
  assert.equal(restarted.request_count, 1);
  assert.ok(
    restarted.window_start.getTime() - expired.window_start.getTime() >= 60_000,
  );

  await setListingRequestLimit(db, key.id, 1);
  await request(detail, 429);
  await setListingRequestLimit(db, key.id, 2);
  await request(detail, 200);
  await request(detail, 429);
  assert.equal((await windowFor()).request_count, 2);

  const rotated = await keyCommand(
    directory,
    "rotate",
    key.id,
    "listings:read",
  );
  assert.equal(await ceiling(rotated.id), 2);
  assert.equal(await windowFor(rotated.id), undefined);
  await request(detail, 401);
  await request(detail, 200, rotated.secret);
  await request(detail, 200, rotated.secret);
  await request(detail, 429, rotated.secret);

  const grants = ["SELECT, INSERT", "UPDATE (window_start, request_count)"];
  let unavailable;
  try {
    for (const privileges of grants)
      await db.query(
        `REVOKE ${privileges} ON idx.listing_request_windows FROM idx_runtime`,
      );
    unavailable = await request(detail, 503, peer.secret);
    assert.equal(unavailable.body.code, "service_unavailable");
    assert.equal((await windowFor(peer.id)).request_count, 1);
  } finally {
    for (const privileges of grants)
      await db.query(
        `GRANT ${privileges} ON idx.listing_request_windows TO idx_runtime`,
      );
  }
  await request(detail, 200, peer.secret);

  await t.test(
    "Node and Worker admit exactly one shared budget",
    { skip: workerRuntime },
    async () => {
      const burst = await keyCommand(
        directory,
        "create",
        site,
        "listings:read",
        "burst",
      );
      await setListingRequestLimit(db, burst.id, 5);
      const worker = await startWorker("packages/engine/wrangler.jsonc", 8790, {
        readyPath: "/api",
      });
      try {
        const responses = await Promise.all(
          Array.from({ length: 16 }, (_, index) =>
            read(detail, burst.secret, index % 2 === 0 ? 8787 : 8790),
          ),
        );
        await Promise.all(
          responses.map((response) => check(response, detailSchema)),
        );
        const statuses = responses.map((response) => response.status).sort();
        assert.deepEqual(statuses, [
          ...Array(5).fill(200),
          ...Array(11).fill(429),
        ]);
        assert.equal((await windowFor(burst.id)).request_count, 5);
      } finally {
        await worker.stop();
      }
    },
  );

  await engine.stop();
  const logs = engine
    .logs()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const [sample, route] of [
    [admitted, detailSchema],
    [refused, detailSchema],
    [refusedSearch, search],
  ] as const) {
    const records = logs.filter((line) => line.requestId === sample.id);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.route, route);
    assert.equal(record.status, sample.response.status);
    assert.equal(record.keyId, key.id);
    assert.equal(new Date(record.timestamp).toISOString(), record.timestamp);
    assert.deepEqual(Object.keys(record).sort(), [
      "code",
      "duration",
      "engineRelease",
      ...(sample.response.status === 429 ? ["errorCode", "errorType"] : []),
      "keyId",
      "method",
      "requestId",
      "route",
      "status",
      "timestamp",
    ]);
  }
  const failure = logs.find((line) => line.requestId === unavailable.id);
  assert.equal(failure?.operation, "key.lookup");
  assert.equal(failure?.errorCode, "42501");
  for (const value of [
    key.secret,
    createHash("sha256").update(key.secret).digest("hex"),
    "lst_demo_0001",
    queryMarker,
    "192.0.2.56",
  ])
    assert.ok(!engine.logs().includes(value));
});

test("detail admission uses two SQL statements and refusal uses one", async (t) => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const runtime = new pg.Client({
    connectionString: process.env.RUNTIME_DATABASE_URL,
  });
  await db.connect();
  await runtime.connect();
  t.after(() => runtime.end());
  const directory = await mkdtemp(`${tmpdir()}/idx-listing-statements-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = await keyCommand(directory, "create", site, "listings:read");
  t.after(async () => {
    try {
      await db.query("DELETE FROM idx.site_secret_keys WHERE id = $1", [
        key.id,
      ]);
    } finally {
      await db.end();
    }
  });
  await setListingRequestLimit(db, key.id, 1);
  const app = createApp(repository(runtime), contract, "test", () => {});
  const counter = t.mock.method(runtime, "query");
  const request = () =>
    app.request(detail, { headers: requestHeaders(key.secret) });
  assert.equal(
    (await check(await request(), detailSchema)).response.status,
    200,
  );
  assert.equal(counter.mock.callCount(), 2);
  counter.mock.resetCalls();
  assert.equal(
    (await check(await request(), detailSchema)).response.status,
    429,
  );
  assert.equal(counter.mock.callCount(), 1);

  await t.test("a refusal sees a reset committed while it waits", async () => {
    const { rows } = await runtime.query("SELECT pg_backend_pid() AS pid");
    await db.query(
      "UPDATE idx.listing_request_windows SET window_start = clock_timestamp() - interval '61 seconds' WHERE key_id = $1",
      [key.id],
    );
    await db.query("BEGIN");
    let pending: ReturnType<typeof request>;
    let blocked = false;
    try {
      await db.query("SELECT idx.charge_listing_request($1, 1)", [key.id]);
      pending = request();
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await db.query(
          "SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS blocked",
          [rows[0].pid],
        );
        blocked = result.rows[0].blocked;
        if (blocked) break;
        await delay(10);
      }
    } finally {
      await db.query("COMMIT");
    }
    const { response } = await check(await pending, detailSchema);
    assert.ok(blocked, "The request must wait for the reset to commit.");
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("Retry-After")) >= 55);
  });
});
