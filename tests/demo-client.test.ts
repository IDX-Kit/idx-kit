import { captureLog, registerSecret } from "./logs.ts";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  engineClient,
  PageFailure,
  searchProblem,
  logFailure,
} from "@idx-kit/demo-site/src/server/engine.ts";

test("demo requests use generated operations with server-only authorization and transport options", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IDX_ENGINE_URL;
  const originalSecret = process.env.IDX_SECRET_KEY;
  const secret = "synthetic-test-secret";
  process.env.IDX_ENGINE_URL = "http://127.0.0.1:8787";
  process.env.IDX_SECRET_KEY = secret;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IDX_ENGINE_URL;
    else process.env.IDX_ENGINE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.IDX_SECRET_KEY;
    else process.env.IDX_SECRET_KEY = originalSecret;
  });
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.ok(!url.href.includes(secret));
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("Authorization"),
      url.pathname === "/api" ? null : `Bearer ${secret}`,
    );
    if (url.pathname === "/api")
      return Response.json({
        data: {
          supportedVersions: [{ major: "v1", capabilities: ["listingDetail"] }],
        },
      });
    if (url.pathname.endsWith("/listings")) {
      assert.equal(
        url.search,
        "?city=Example+Springs&minPrice=350000.00&sort=-price",
      );
      return Response.json(
        { code: "invalid_query" },
        { status: 400, headers: { "Request-Id": "req_synthetic" } },
      );
    }
    return Response.json({ data: { id: "lst_synthetic" } });
  };
  const engine = engineClient();
  await engine.discover();
  assert.equal(
    (await engine.listing("lst_synthetic")).data.id,
    "lst_synthetic",
  );
  await assert.rejects(
    engine.search({
      city: "Example Springs",
      minPrice: "350000.00",
      sort: "-price",
    }),
    (error) => {
      assert.ok(error instanceof PageFailure);
      assert.equal(error.status, 400);
      assert.equal(error.requestId, "req_synthetic");
      assert.equal(searchProblem(error).code, "invalid_query");
      return true;
    },
  );
  assert.deepEqual(paths, [
    "/api",
    "/api/v1/listings/lst_synthetic",
    "/api/v1/listings",
  ]);
  for (const base of [
    "file:///tmp",
    "http://user:password@127.0.0.1",
    "http://127.0.0.1/prefix",
    "http://127.0.0.1/?query",
    "http://127.0.0.1/#hash",
  ]) {
    process.env.IDX_ENGINE_URL = base;
    assert.throws(engineClient);
  }
});

test("all demo engine HTTP calls stay behind the generated client", async () => {
  const directory = "examples/demo-site/src";
  const files = (await readdir(directory, { recursive: true })).filter((path) =>
    /\.(ts|astro)$/.test(path),
  );
  for (const path of [
    ...files.map((path) => `${directory}/${path}`),
    "examples/demo-site/start.mjs",
  ]) {
    assert.doesNotMatch(await readFile(path, "utf8"), /\bfetch\s*\(/, path);
  }
});


test("site failures log once with status, request ID, path and redacted causes", async (t) => {
  const savedFetch = globalThis.fetch;
  const savedUrl = process.env.IDX_ENGINE_URL;
  const savedKey = process.env.IDX_SECRET_KEY;
  const secret = "idx_secret_synthetic_site_canary";
  registerSecret(secret);
  const hash = createHash("sha256").update(secret).digest("hex");
  const logs: string[] = [];
  t.mock.method(console, "error", (line: string) => {
    logs.push(line);
    captureLog("site-unit", line + "\n");
  });
  process.env.IDX_ENGINE_URL = "http://127.0.0.1:8787";
  process.env.IDX_SECRET_KEY = secret;
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.IDX_ENGINE_URL;
    else process.env.IDX_ENGINE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.IDX_SECRET_KEY;
    else process.env.IDX_SECRET_KEY = savedKey;
  });
  globalThis.fetch = async () => Response.json({}, { status: 401, headers: { "Request-Id": "req_synthetic_key" } });
  const engine = engineClient();
  await assert.rejects(engine.search({}), (error) => {
    logFailure(error, engine.context());
    return true;
  });
  assert.equal(logs.length, 1);
  const wrong = JSON.parse(logs[0]);
  assert.equal(wrong.category, "key_problem");
  assert.equal(wrong.upstreamStatus, 401);
  assert.equal(wrong.requestId, "req_synthetic_key");
  assert.equal(wrong.path, "/api/v1/listings");
  globalThis.fetch = async () => { throw new TypeError(`Synthetic connection failure ${secret} ${hash} postgresql://user:synthetic_password@db.invalid/demo`); };
  await assert.rejects(engine.listing("lst_synthetic"));
  const outage = JSON.parse(logs[1]);
  assert.equal(outage.category, "engine_outage");
  assert.equal(outage.upstreamStatus, null);
  assert.equal(outage.requestId, null);
  assert.equal(outage.errorType, "TypeError");
  assert.equal(outage.path, "/api/v1/listings/{listingId}");
  assert.match(outage.message, /Synthetic connection failure/);
  assert.ok(!logs.join("").includes(secret) && !logs.join("").includes(hash) && !logs.join("").includes("synthetic_password"));
});
