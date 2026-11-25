import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pg from "pg";
import { keyCommand, preserveKeys, startEngine } from "../api/runtime.ts";
import { validateResponse } from "../api/contract.ts";

test("Hyperdrive uses idx_runtime and logs the correlated database denial", async () => {
  const directory = await mkdtemp(`${tmpdir()}/idx-worker-db-`);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const restoreKeys = await preserveKeys(db);
  let inquiryId: string | undefined;
  let engine: Awaited<ReturnType<typeof startEngine>> | undefined;
  try {
    const { secret } = await keyCommand(
      directory,
      "create",
      "site_demo_primary",
      "listings:read,inquiries:write,inquiries:read",
    );
    engine = await startEngine();
    const request = () =>
      fetch("http://127.0.0.1:8787/api/v1/listings/lst_demo_0001", {
        headers: { Authorization: `Bearer ${secret}` },
      });
    assert.equal((await request()).status, 200);
    const create = await fetch("http://127.0.0.1:8787/api/v1/inquiries", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Idempotency-Key": `"${randomUUID()}"` },
      body: JSON.stringify({
        listingId: "lst_demo_0001",
        visitor: { name: "Synthetic Worker Visitor", email: "worker@example.invalid" },
        message: "Synthetic Worker insert privilege proof.",
        context: { pagePath: "/properties/lst_demo_0001" },
      }),
    });
    const receipt = await create.json();
    assert.equal(create.status, 201);
    validateResponse("/api/v1/inquiries", create, receipt, false, "post");
    inquiryId = receipt.data.id;
    const read = await fetch(`http://127.0.0.1:8787${create.headers.get("Location")}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const readBody = await read.json();
    assert.equal(read.status, 200);
    validateResponse("/api/v1/inquiries/{inquiryId}", read, readBody);
    assert.deepEqual(readBody, receipt);
    await db.query("REVOKE SELECT ON idx.site_secret_keys FROM idx_runtime");
    const response = await request();
    const body = await response.json();
    assert.equal(response.status, 503);
    validateResponse("/api/v1/listings/{listingId}", response, body);
    await engine.stop();
    const records = engine
      .logs()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failure = records.filter(
      (record) => record.requestId === body.requestId,
    );
    assert.equal(failure.length, 1);
    assert.equal(failure[0].operation, "key.lookup");
    assert.equal(failure[0].errorCode, "42501");
    assert.equal(typeof failure[0].errorType, "string");
    await db.query("GRANT SELECT ON idx.site_secret_keys TO idx_runtime");
    engine = await startEngine();
    assert.equal((await request()).status, 200);
  } finally {
    await engine?.stop();
    await db.query("GRANT SELECT ON idx.site_secret_keys TO idx_runtime");
    if (inquiryId) await db.query("DELETE FROM idx.inquiries WHERE id=$1", [inquiryId]);
    await restoreKeys();
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
