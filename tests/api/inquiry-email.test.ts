import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import type { InquiryInput } from "@idx-kit/client";
import { registerSecret } from "../logs.ts";
import { validateResponse } from "./contract.ts";
import {
  emailSettings,
  startEmailStub,
  waitForEmailLog,
} from "./email-stub.ts";
import { execute, keyCommand, startEngine } from "./runtime.ts";

const path = "/api/v1/inquiries";
const origin = "http://127.0.0.1:8787";
// The visitor, addresses and message are invented test data.
const input: InquiryInput = {
  listingId: "lst_demo_0001",
  visitor: { name: "Invented Email Visitor", email: "lead@example.invalid" },
  message: "Synthetic email test. Is a showing available?",
  context: {
    pagePath: "/properties/lst_demo_0001",
    landingPagePath: "/guides/example-springs",
  },
};

test("inquiry email through Resend", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(`${tmpdir()}/idx-inquiry-email-`);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { id: keyId, secret } = await keyCommand(
    directory,
    "create",
    "site_demo_primary",
    "inquiries:write,inquiries:read",
  );
  const stub = await startEmailStub();
  const enabled = { ...emailSettings, RESEND_BASE_URL: stub.baseUrl };
  const privateValues = [
    ...Object.values(emailSettings),
    input.visitor.name,
    input.visitor.email,
    input.message,
  ];
  privateValues.forEach(registerSecret);
  const logs: string[] = [];
  const keys = new Set<string>();
  let engine = await startEngine(enabled);
  t.after(async () => {
    await engine.stop();
    await stub.close();
    await db.query(
      "DELETE FROM idx.inquiries WHERE site_id='site_demo_primary' AND idempotency_key=ANY($1)",
      [[...keys]],
    );
    await db.query("DELETE FROM idx.site_secret_keys WHERE id=$1", [keyId]);
    await db.end();
    await rm(directory, { recursive: true, force: true });
  });

  async function create(
    key = `"${randomUUID()}"`,
    body = input,
    status = 201,
    signal?: AbortSignal,
  ) {
    keys.add(key);
    const response = await fetch(origin + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
      signal,
    });
    assert.equal(response.status, status);
    const content = await response.json();
    validateResponse(path, response, content, false, "post");
    return {
      receipt: content,
      requestId: response.headers.get("Request-Id"),
      location: response.headers.get("Location"),
    };
  }

  async function readKept(created: Awaited<ReturnType<typeof create>>) {
    const { id, receivedAt } = created.receipt.data;
    assert.deepEqual(created.receipt, { data: { id, receivedAt }, meta: {} });
    assert.equal(created.location, `${path}/${id}`);
    const response = await fetch(origin + created.location, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), created.receipt);
    const { rows } = await db.query(
      "SELECT received_at FROM idx.inquiries WHERE id=$1",
      [id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].received_at.toISOString(), receivedAt);
  }

  async function expectEmail(
    created: Awaited<ReturnType<typeof create>>,
    errorType?: string,
    upstreamStatus: number | null = null,
  ) {
    assert.deepEqual(await waitForEmailLog(engine, created.requestId), {
      operation: "inquiry.email",
      inquiryId: created.receipt.data.id,
      requestId: created.requestId,
      ...(errorType
        ? { outcome: "failure", errorType, upstreamStatus }
        : { outcome: "success" }),
    });
  }

  const key = `"${randomUUID()}"`;
  await t.test(
    "the receipt and row are available while Resend holds its response",
    async () => {
      const gate = Promise.withResolvers<void>();
      stub.hold(gate.promise);
      let created;
      try {
        created = await create(key, input, 201, AbortSignal.timeout(2000));
        await readKept(created);
        await stub.waitForSends(1);
        assert.ok(!engine.logs().includes('"inquiry.email"'));
      } finally {
        gate.resolve();
      }
      await expectEmail(created);
      assert.equal(stub.sent.length, 1);
      const [send] = stub.sent;
      const { id, receivedAt } = created.receipt.data;
      const address =
        "101 Imaginary Lantern Lane, Example Springs, NC, 00000, US";
      assert.equal(send.method, "POST");
      assert.equal(send.path, "/emails");
      assert.ok(
        send.headers.authorization === `Bearer ${emailSettings.RESEND_API_KEY}`,
      );
      assert.equal(send.headers["idempotency-key"], id);
      assert.deepEqual(send.body, {
        from: emailSettings.INQUIRY_EMAIL_FROM,
        to: emailSettings.INQUIRY_EMAIL_TO,
        reply_to: input.visitor.email,
        subject: `New inquiry for ${address}`,
        text: [
          `Name: ${input.visitor.name}`,
          `Email: ${input.visitor.email}`,
          `Listing ID: ${input.listingId}`,
          `Listing address: ${address}`,
          `Page path: ${input.context.pagePath}`,
          `Landing page path: ${input.context.landingPagePath}`,
          `Received at: ${receivedAt}`,
          `Inquiry ID: ${id}`,
          "",
          "Message:",
          input.message,
        ].join("\n"),
      });
      assert.deepEqual((await create(key)).receipt, created.receipt);
      await create(
        key,
        { ...input, message: "Changed synthetic message" },
        422,
      );
      await create(
        undefined,
        { ...input, listingId: "lst_missing_synthetic" },
        404,
      );
      await db.query("REVOKE INSERT ON idx.inquiries FROM idx_runtime");
      try {
        await create(undefined, input, 503);
      } finally {
        await db.query("GRANT INSERT ON idx.inquiries TO idx_runtime");
      }
      assert.equal(stub.sent.length, 1);
    },
  );

  await t.test(
    "concurrent duplicates send once and withhold a restricted address",
    async () => {
      const listingId = "lst_demo_0002";
      const body = {
        ...input,
        listingId,
        context: { pagePath: `/properties/${listingId}` },
      };
      const duplicate = `"${randomUUID()}"`;
      await db.query("BEGIN");
      await db.query("LOCK TABLE idx.inquiries IN SHARE MODE");
      const pending = Promise.all(
        Array.from({ length: 4 }, () => create(duplicate, body)),
      );
      void pending.catch(() => {});
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const { rowCount } = await db.query(
            "SELECT 1 FROM pg_locks WHERE relation='idx.inquiries'::regclass AND NOT granted",
          );
          if (rowCount === 4) break;
          assert.ok(attempt < 99, "All four inserts must reach the table lock");
          await setTimeout(10);
        }
        assert.equal(stub.sent.length, 1);
      } finally {
        await db.query("ROLLBACK");
      }
      const results = await pending;
      for (const result of results)
        assert.deepEqual(result.receipt, results[0].receipt);
      const { rowCount } = await db.query(
        "SELECT 1 FROM idx.inquiries WHERE site_id='site_demo_primary' AND idempotency_key=$1",
        [duplicate],
      );
      assert.equal(rowCount, 1);
      await stub.waitForSends(2);
      const send = stub.sent[1];
      assert.equal(send.headers["idempotency-key"], results[0].receipt.data.id);
      assert.equal(send.body.subject, `New inquiry for ${listingId}`);
      assert.match(String(send.body.text), /Listing address: Unavailable/);
      assert.doesNotMatch(
        String(send.body.text),
        /Hidden Stardust|Landing page path/,
      );
    },
  );

  await t.test(
    "upstream 500, timeout and refused connection leave readable receipts",
    async () => {
      stub.status(500);
      const rejected = await create();
      await expectEmail(rejected, "EmailServiceError", 500);
      await readKept(rejected);
      const gate = Promise.withResolvers<void>();
      stub.hold(gate.promise);
      try {
        const timedOut = await create();
        await expectEmail(timedOut, "TimeoutError");
        await readKept(timedOut);
      } finally {
        gate.resolve();
      }
      assert.equal(stub.sent.length, 4);
      await engine.stop();
      logs.push(engine.logs());
      const closedStub = await startEmailStub();
      await closedStub.close();
      engine = await startEngine({
        ...enabled,
        RESEND_BASE_URL: closedStub.baseUrl,
      });
      const refused = await create();
      await expectEmail(refused, "NetworkError");
      await readKept(refused);
    },
  );

  await t.test(
    "no email settings stay quiet and partial settings stop Node at startup",
    async () => {
      await engine.stop();
      logs.push(engine.logs());
      engine = await startEngine({ RESEND_BASE_URL: stub.baseUrl });
      await readKept(await create());
      assert.ok(!engine.logs().includes('"inquiry.email"'));
      assert.equal(stub.sent.length, 4);
      await assert.rejects(
        execute(process.execPath, ["packages/engine/src/runtime/node.ts"], {
          env: { ...process.env, RESEND_API_KEY: enabled.RESEND_API_KEY },
          timeout: 5000,
        }),
        (error: { code: number; stderr: string }) => {
          assert.equal(error.code, 1);
          assert.match(
            error.stderr,
            /Set all three inquiry email settings together/,
          );
          logs.push(error.stderr);
          return true;
        },
      );
      for (const value of privateValues) {
        assert.ok(![...logs, engine.logs()].some((log) => log.includes(value)));
      }
    },
  );
});
