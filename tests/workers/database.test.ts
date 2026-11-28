import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { SmartRouter } from "hono/router/smart-router";
import { configs, readConfig } from "../../scripts/check-worker-config.mjs";
import { keyCommand, preserveKeys } from "../api/runtime.ts";
import { validateResponse } from "../api/contract.ts";
import { postInquiry } from "../api/inquiry-request.ts";
import {
  emailSettings,
  startEmailStub,
  waitForEmailLog,
} from "../api/email-stub.ts";
import {
  startTurnstileStub,
  tokens,
  turnstileSettings,
} from "../api/turnstile-stub.ts";
import { startWorker } from "./runtime.ts";

test("the HTTP Worker reuses routes and creates no database client for discovery", async (t) => {
  const registrations = t.mock.method(SmartRouter.prototype, "add");
  const { default: worker } =
    await import("@idx-kit/engine/src/runtime/worker.ts");
  const env = {
    get HYPERDRIVE(): never {
      throw new Error("Discovery must skip the database client");
    },
  };
  const context = { waitUntil() {} };
  const request = async (path: string) => {
    const response = await worker.fetch(
      new Request(`https://engine.example.invalid${path}`),
      env,
      context,
    );
    assert.equal(response.status, 200);
    validateResponse(path, response, await response.json());
  };
  await request("/api");
  const routeCount = registrations.mock.callCount();
  assert.ok(routeCount > 0);
  await request("/api/v1/openapi.json");
  assert.equal(registrations.mock.callCount(), routeCount);
});

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
  const privateValues = [
    visitor.name,
    visitor.email,
    message,
    tokens.valid,
    turnstileSettings.TURNSTILE_SECRET_KEY,
  ];
  const stub = await startEmailStub();
  const turnstile = await startTurnstileStub(privateValues);
  let engine: Awaited<ReturnType<typeof startWorker>> | undefined;
  const { config } = await readConfig(configs.engine);
  async function start(vars: Record<string, unknown>) {
    const path = `${directory}/wrangler.json`;
    await writeFile(
      path,
      JSON.stringify({
        ...config,
        main: resolve("tests/workers/email-entry.ts"),
        define: {
          IDX_TEST_RESEND_URL: JSON.stringify(stub.baseUrl),
          IDX_TEST_TURNSTILE_URL: JSON.stringify(turnstile.baseUrl),
        },
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
    engine = await start({ ...emailSettings, ...turnstileSettings });
    const request = () =>
      fetch("http://127.0.0.1:8787/api/v1/listings/lst_demo_0001", {
        headers: { Authorization: `Bearer ${secret}` },
      });
    assert.equal((await request()).status, 200);
    const createInquiry = async (token?: string, status = 201) => {
      const key = `"${randomUUID()}"`;
      const { response, content: receipt } = await postInquiry(
        secret,
        key,
        {
          listingId: "lst_demo_0001",
          visitor,
          message,
          context: { pagePath: "/properties/lst_demo_0001" },
        },
        status,
        { headers: token ? { "Turnstile-Token": token } : undefined },
      );
      if (status === 201) inquiryIds.push(receipt.data.id);
      else {
        const { rowCount } = await db.query(
          "SELECT 1 FROM idx.inquiries WHERE site_id=$1 AND idempotency_key=$2",
          ["site_demo_primary", key],
        );
        assert.equal(rowCount, 0);
      }
      return { response, receipt };
    };
    const release = stub.hold();
    let created;
    try {
      await db.query("BEGIN");
      await db.query("LOCK TABLE idx.inquiries IN SHARE MODE");
      const pending = createInquiry(tokens.valid);
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
    assert.equal(turnstile.checks.length, 1);
    assert.equal(turnstile.checks[0].body.response, tokens.valid);
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
    for (const invalid of [73, {}]) {
      engine = await start({ TURNSTILE_SECRET_KEY: invalid });
      const { response, receipt } = await createInquiry(tokens.valid, 503);
      assert.equal(receipt.code, "service_unavailable");
      assert.equal(receipt.requestId, response.headers.get("Request-Id"));
      await engine.stop();
      const records = engine
        .logs()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        records.filter((record) => record.operation === "inquiry.spam_check"),
        [
          {
            operation: "inquiry.spam_check",
            outcome: "failure",
            requestId: receipt.requestId,
            errorType: "ConfigurationError",
            upstreamStatus: null,
            turnstileErrorCodes: [],
          },
        ],
      );
      for (const value of privateValues)
        assert.ok(!engine.logs().includes(value));
    }
    assert.equal(turnstile.checks.length, 1);
  } finally {
    await engine?.stop();
    await stub.close();
    await turnstile.close();
    await db.query("GRANT SELECT ON idx.site_secret_keys TO idx_runtime");
    await db.query("DELETE FROM idx.inquiries WHERE id=ANY($1)", [inquiryIds]);
    await restoreKeys();
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
