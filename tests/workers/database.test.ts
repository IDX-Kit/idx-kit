import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import ts from "typescript";
import { keyCommand, preserveKeys } from "../api/runtime.ts";
import { validateResponse } from "../api/contract.ts";
import {
  emailSettings,
  startEmailStub,
  waitForEmailLog,
} from "../api/email-stub.ts";
import { registerSecret } from "../logs.ts";
import { startWorker } from "./runtime.ts";

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
  let engine: Awaited<ReturnType<typeof startWorker>> | undefined;
  const { config, error } = ts.readConfigFile(
    "packages/engine/wrangler.jsonc",
    ts.sys.readFile,
  );
  assert.ok(!error);
  async function start(vars: Record<string, unknown>) {
    const path = `${directory}/wrangler.json`;
    await writeFile(
      path,
      JSON.stringify({
        ...config,
        main: resolve("tests/workers/email-entry.ts"),
        define: { IDX_TEST_RESEND_URL: JSON.stringify(stub.baseUrl) },
        vars: { ...vars, RESEND_BASE_URL: stub.baseUrl + "/wrong" },
      }),
    );
    return startWorker(path, 8787);
  }
  try {
    const { secret } = await keyCommand(
      directory,
      "create",
      "site_demo_primary",
      "listings:read,inquiries:write,inquiries:read",
    );
    engine = await start(emailSettings);
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
      await db.query("BEGIN");
      await db.query("LOCK TABLE idx.inquiries IN SHARE MODE");
      const pending = createInquiry();
      void pending.catch(() => {});
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (engine.logs().includes('"test.waitUntil"')) break;
          assert.ok(
            attempt < 99,
            "waitUntil must register before the insert can finish",
          );
          await setTimeout(10);
        }
        assert.equal(stub.sent.length, 0);
      } finally {
        await db.query("ROLLBACK");
      }
      created = await pending;
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
    assert.equal(stub.sent[0].path, "/emails");
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
    for (const invalid of [
      { INQUIRY_EMAIL_FROM: emailSettings.INQUIRY_EMAIL_FROM },
      { INQUIRY_EMAIL_FROM: {}, INQUIRY_EMAIL_TO: 73 },
    ]) {
      engine = await start(invalid);
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
      for (const value of [...privateValues, ...Object.values(emailSettings)])
        assert.ok(!engine.logs().includes(value));
      await engine.stop();
    }
    assert.equal(stub.sent.length, 1);
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
