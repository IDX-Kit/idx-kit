import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pg from "pg";
import type { InquiryInput } from "@idx-kit/client";
import { validateResponse } from "./contract.ts";
import { keyCommand, startEngine } from "./runtime.ts";
import {
  startTurnstileStub,
  tokens,
  turnstileSettings,
} from "./turnstile-stub.ts";

const site = "site_demo_primary";
const path = "/api/v1/inquiries";
// The visitor and inquiry details are invented test data.
const input: InquiryInput = {
  listingId: "lst_demo_0001",
  visitor: {
    name: "Synthetic Turnstile Visitor",
    email: "turnstile-visitor@example.invalid",
  },
  message: "Synthetic spam check inquiry.",
  context: { pagePath: "/properties/lst_demo_0001" },
};

test("inquiry spam check through Turnstile", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(`${tmpdir()}/idx-inquiry-spam-`);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const apiKey = await keyCommand(directory, "create", site, "inquiries:write");
  const privateValues = [
    ...Object.values(turnstileSettings),
    ...Object.values(tokens),
    input.visitor.name,
    input.visitor.email,
    input.message,
  ];
  const stub = await startTurnstileStub(privateValues);
  const vars = { IDX_TEST_TURNSTILE_URL: stub.baseUrl };
  const keys: string[] = [];
  let engine: Awaited<ReturnType<typeof startEngine>> | undefined;
  t.after(async () => {
    await engine?.stop();
    await stub.close();
    await db.query(
      "DELETE FROM idx.inquiries WHERE site_id=$1 AND idempotency_key=ANY($2)",
      [site, keys],
    );
    await db.query("DELETE FROM idx.site_secret_keys WHERE id=$1", [apiKey.id]);
    await db.end();
    await rm(directory, { recursive: true, force: true });
  });

  const newKey = () => `"${randomUUID()}"`;
  async function create({
    key = newKey(),
    body = input,
    token,
    status = 201,
    code,
  }: {
    key?: string;
    body?: InquiryInput;
    token?: string;
    status?: number;
    code?: string;
  } = {}) {
    keys.push(key);
    const headers = new Headers({
      Authorization: `Bearer ${apiKey.secret}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    });
    if (token !== undefined) headers.set("Turnstile-Token", token);
    const response = await fetch(`http://127.0.0.1:8787${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    const content = await response.json();
    validateResponse(path, response, content, false, "post");
    const requestId = response.headers.get("Request-Id");
    assert.ok(requestId);
    if (code) {
      assert.equal(content.code, code);
      assert.equal(content.status, status);
      assert.equal(content.requestId, requestId);
    }
    const { rowCount } = await db.query(
      "SELECT 1 FROM idx.inquiries WHERE site_id=$1 AND idempotency_key=$2",
      [site, key],
    );
    const kept = status === 201 || code === "idempotency_mismatch";
    assert.equal(rowCount, kept ? 1 : 0);
    return {
      receipt: content,
      requestId,
      location: response.headers.get("Location"),
    };
  }

  function expectFailureLog(
    requestId: string,
    errorType: string,
    upstreamStatus: number | null,
    turnstileErrorCodes: string[] = [],
  ) {
    const failures = engine!
      .logs()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        (record) =>
          record.operation === "inquiry.spam_check" &&
          record.requestId === requestId,
      );
    assert.deepEqual(failures, [
      {
        operation: "inquiry.spam_check",
        outcome: "failure",
        requestId,
        errorType,
        upstreamStatus,
        turnstileErrorCodes,
      },
    ]);
  }

  await t.test("unset secret skips the check", async () => {
    engine = await startEngine(vars);
    await create();
    await engine.stop();
    assert.equal(stub.checks.length, 0);
    assert.doesNotMatch(engine.logs(), /inquiry\.spam_check/);
  });
  engine = await startEngine({
    ...vars,
    ...turnstileSettings,
    TURNSTILE_SITEVERIFY_URL: stub.baseUrl + "/wrong",
  });

  await t.test("checks only new inquiries", async () => {
    const key = newKey();
    const created = await create({ key, token: tokens.valid });
    assert.deepEqual(stub.checks, [
      {
        method: "POST",
        path: "/turnstile/v0/siteverify",
        body: {
          secret: turnstileSettings.TURNSTILE_SECRET_KEY,
          response: tokens.valid,
          idempotency_key: key.slice(1, -1),
        },
      },
    ]);
    for (const token of [undefined, tokens.valid, tokens.invalid]) {
      const replay = await create({ key, token });
      assert.deepEqual(replay.receipt, created.receipt);
      assert.equal(replay.location, created.location);
      assert.notEqual(replay.requestId, created.requestId);
    }
    await create({
      key,
      body: { ...input, message: "Changed synthetic message." },
      status: 422,
      code: "idempotency_mismatch",
    });
    assert.equal(stub.checks.length, 1);
  });

  await t.test("rejects missing, invalid and reused tokens", async () => {
    const missing = await create({ status: 422, code: "spam_check_failed" });
    expectFailureLog(missing.requestId, "MissingToken", null);
    assert.equal(stub.checks.length, 1);
    for (const [token, error] of [
      [tokens.invalid, "invalid-input-response"],
      [tokens.valid, "timeout-or-duplicate"],
    ]) {
      const rejected = await create({
        token,
        status: 422,
        code: "spam_check_failed",
      });
      expectFailureLog(rejected.requestId, "RejectedToken", 200, [error]);
      assert.equal(stub.checks.at(-1)?.body.response, token);
    }
    assert.equal(stub.checks.length, 3);
  });

  await t.test("fails closed when verification is unavailable", async () => {
    for (const [token, error, upstreamStatus, codes] of [
      [tokens.upstreamError, "TurnstileServiceError", 502, []],
      [tokens.internalError, "TurnstileServiceError", 200, ["internal-error"]],
      [tokens.slow, "TimeoutError", 200, []],
    ] as const) {
      const unavailable = await create({
        token,
        status: 503,
        code: "service_unavailable",
      });
      expectFailureLog(unavailable.requestId, error, upstreamStatus, [
        ...codes,
      ]);
      assert.equal(stub.checks.at(-1)?.body.response, token);
    }
    await stub.close();
    const refused = await create({
      token: tokens.valid,
      status: 503,
      code: "service_unavailable",
    });
    expectFailureLog(refused.requestId, "NetworkError", null);
  });

  for (const value of privateValues) assert.ok(!engine.logs().includes(value));
});
