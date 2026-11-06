import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { createApp } from "@idx-kit/engine/src/http/app.ts";
import {
  searchCursor,
  searchQuery,
  searchSchema,
} from "@idx-kit/engine/src/domain/search-query.ts";
import type { Repository } from "@idx-kit/engine/src/db/read.ts";
import { captureLog, registerSecret } from "./logs.ts";
import { execute } from "./api/runtime.ts";

const filters = {
  city: " Example Springs ",
  minPrice: "0.00",
  maxPrice: "900000",
  minBedrooms: "0",
  sort: "price",
  limit: "1",
};

test("compact cursor binds every normalized filter, site and position", () => {
  const original = searchQuery(searchSchema.parse(filters), "site_synthetic");
  const cursor = searchCursor(original.context, {
    price: "425000",
    id: "lst_demo_0001",
  });
  assert.ok(Buffer.byteLength(cursor) < 100);
  assert.deepEqual(
    searchQuery(
      searchSchema.parse({ ...filters, after: cursor }),
      "site_synthetic",
    ).last,
    { price: "425000", id: "lst_demo_0001" },
  );
  for (const change of [
    { city: "Other City" },
    { minPrice: "1" },
    { maxPrice: "800000" },
    { minBedrooms: "1" },
    { sort: "-price" },
    { limit: "2" },
  ]) {
    assert.throws(
      () =>
        searchQuery(
          searchSchema.parse({ ...filters, ...change, after: cursor }),
          "site_synthetic",
        ),
      { code: "cursor_invalid" },
    );
  }
  assert.throws(
    () =>
      searchQuery(
        searchSchema.parse({ ...filters, after: cursor }),
        "site_other",
      ),
    { code: "cursor_invalid" },
  );
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
  for (const position of [
    ["1", decoded[1], decoded[2]],
    [decoded[0], "lst_other", decoded[2]],
  ]) {
    const tampered = Buffer.from(JSON.stringify(position)).toString(
      "base64url",
    );
    assert.throws(
      () =>
        searchQuery(
          searchSchema.parse({ ...filters, after: tampered }),
          "site_synthetic",
        ),
      { code: "cursor_invalid" },
    );
  }
});

test("unexpected exceptions and middleware errors use problems and redacted request logs", async () => {
  const secret = "idx_secret_synthetic_logging_canary";
  registerSecret(secret);
  const hash = createHash("sha256").update(secret).digest("hex");
  const lines: string[] = [];
  const db: Repository = {
    key: async () => undefined,
    listing: async () => undefined,
    search: async () => ({ feeds: [], rows: [] }),
  };
  const app = createApp(db, {}, "synthetic", (line) => {
    lines.push(line);
    captureLog("engine-unit", line + "\n");
  });
  app.get("/throw", () => {
    throw new TypeError(
      `Synthetic cause ${secret} ${hash} postgresql://user:synthetic_password@db.invalid/demo`,
    );
  });
  const response = await app.request("/throw", {
    headers: { "Request-Id": "untrusted-request-id" },
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "internal_error");
  assert.equal(body.requestId, response.headers.get("Request-Id"));
  assert.notEqual(body.requestId, "untrusted-request-id");
  const log = JSON.parse(lines[0]);
  assert.equal(log.requestId, body.requestId);
  assert.equal(log.errorType, "TypeError");
  assert.match(log.message, /Synthetic cause/);
  assert.match(log.stack, /TypeError/);
  assert.ok(
    !lines[0].includes(secret) &&
      !lines[0].includes(hash) &&
      !lines[0].includes("synthetic_password"),
  );
  app.get("/middleware", () => {
    throw new HTTPException(401);
  });
  assert.equal(
    (await (await app.request("/middleware")).json()).code,
    "unauthorized",
  );
  for (const authorization of [
    "Basic wrong",
    "Bearer x,y",
    "Bearer",
    "Bearer wrong",
  ]) {
    const result = await app.request("/api/v1/listings", {
      headers: { Authorization: authorization },
    });
    assert.equal(result.status, 401);
    assert.equal(result.headers.get("WWW-Authenticate"), "Bearer");
    assert.equal((await result.json()).code, "unauthorized");
  }
});

test("key command bad input exits nonzero and prints a reason", async () => {
  await assert.rejects(
    execute(process.execPath, [
      "packages/engine/src/runtime/key.ts",
      "invalid",
    ]),
    (error) => {
      const result = error as Error & { code: number; stderr: string };
      captureLog("key", result.stderr);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Usage:/);
      return true;
    },
  );
});
