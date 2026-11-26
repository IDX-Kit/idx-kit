import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pg from "pg";
import { keyCommand, preserveKeys, startEngine } from "../api/runtime.ts";
import { validateResponse } from "../api/contract.ts";
import {
  emailSettings,
  startEmailStub,
  waitForEmailLog,
} from "../api/email-stub.ts";
import { registerSecret } from "../logs.ts";

test("Hyperdrive uses idx_runtime and logs the correlated database denial", async () => {
  const directory = await mkdtemp(`${tmpdir()}/idx-worker-db-`);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const restoreKeys = await preserveKeys(db);
  const inquiryIds: string[] = [];
  // The visitor and message are invented test data.
  const visitor = {
    name: "Synthetic Worker Visitor",
    email: "worker@example.invalid",
  };
  const message = "Synthetic Worker insert privilege proof.";
  const privateValues = [visitor.name, visitor.email, message];
  privateValues.forEach(registerSecret);
  const stub = await startEmailStub();
  let engine: Awaited<ReturnType<typeof startEngine>> | undefined;
  try {
    const { secret } = await keyCommand(
      directory,
      "create",
      "site_demo_primary",
      "listings:read,inquiries:write,inquiries:read",
    );
    engine = await startEngine({
      ...emailSettings,
      RESEND_BASE_URL: stub.baseUrl,
    });
    const request = () =>
      fetch("http://127.0.0.1:8787/api/v1/listings/lst_demo_0001", {
        headers: { Authorization: `Bearer ${secret}` },
      });
    assert.equal((await request()).status, 200);
    const createInquiry = async () => {
      const response = await fetch("http://127.0.0.1:8787/api/v1/inquiries", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `"${randomUUID()}"`,
        },
        body: JSON.stringify({
          listingId: "lst_demo_0001",
          visitor,
          message,
          context: { pagePath: "/properties/lst_demo_0001" },
        }),
      });
      const receipt = await response.json();
      assert.equal(response.status, 201);
      validateResponse("/api/v1/inquiries", response, receipt, false, "post");
      inquiryIds.push(receipt.data.id);
      return { response, receipt };
    };
    const release = stub.hold();
    let created;
    try {
      created = await createInquiry();
      await stub.waitForSends(1);
      assert.ok(!engine.logs().includes('"inquiry.email"'));
    } finally {
      release();
    }
    const { response: create, receipt } = created;
    const requestId = create.headers.get("Request-Id");
    assert.deepEqual(await waitForEmailLog(engine, requestId), {
      operation: "inquiry.email",
      inquiryId: receipt.data.id,
      requestId,
      outcome: "success",
    });
    assert.equal(stub.sent[0].headers["idempotency-key"], receipt.data.id);
    const read = await fetch(
      `http://127.0.0.1:8787${create.headers.get("Location")}`,
      {
        headers: { Authorization: `Bearer ${secret}` },
      },
    );
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
    for (const value of [...privateValues, ...Object.values(emailSettings)])
      assert.ok(!engine.logs().includes(value));
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
    engine = await startEngine({
      INQUIRY_EMAIL_FROM: emailSettings.INQUIRY_EMAIL_FROM,
      RESEND_BASE_URL: stub.baseUrl,
    });
    assert.equal((await request()).status, 200);
    const partial = await createInquiry();
    const partialId = partial.response.headers.get("Request-Id");
    assert.deepEqual(await waitForEmailLog(engine, partialId), {
      operation: "inquiry.email",
      inquiryId: partial.receipt.data.id,
      requestId: partialId,
      outcome: "failure",
      errorType: "ConfigurationError",
      upstreamStatus: null,
    });
    const kept = await db.query("SELECT 1 FROM idx.inquiries WHERE id=$1", [
      partial.receipt.data.id,
    ]);
    assert.equal(kept.rowCount, 1);
    assert.equal(stub.sent.length, 1);
    for (const value of [...privateValues, ...Object.values(emailSettings)])
      assert.ok(!engine.logs().includes(value));
  } finally {
    await engine?.stop();
    await stub.close();
    await db.query("GRANT SELECT ON idx.site_secret_keys TO idx_runtime");
    await db.query("DELETE FROM idx.inquiries WHERE id=ANY($1)", [inquiryIds]);
    await restoreKeys();
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
