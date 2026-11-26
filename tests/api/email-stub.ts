import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { json } from "node:stream/consumers";
import { setTimeout } from "node:timers/promises";
import { registerSecret } from "../logs.ts";
import { listenOnLoopback } from "./loopback-server.ts";

// These addresses and the API key are synthetic and used only on loopback.
export const emailSettings = {
  RESEND_API_KEY: "re_synthetic_inquiry_test_key",
  INQUIRY_EMAIL_FROM: "sender@example.invalid",
  INQUIRY_EMAIL_TO: "recipient@example.invalid",
};

export async function startEmailStub() {
  const sent: {
    method: string | undefined;
    path: string | undefined;
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
  }[] = [];
  let gate: Promise<void> | undefined;
  let status = 200;
  const server = await listenOnLoopback(async (request, response) => {
    const body = (await json(request)) as Record<string, unknown>;
    sent.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body,
    });
    await gate;
    if (response.destroyed) return;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        status === 200
          ? { id: "synthetic-email-id" }
          : {
              ...(status === 500 ? { statusCode: 500 } : {}),
              name: "application_error",
              // Deliberately echo private fields to exercise log redaction.
              message: JSON.stringify({
                body,
                key: request.headers.authorization,
              }),
            },
      ),
    );
  });
  Object.values(emailSettings).forEach(registerSecret);
  return {
    sent,
    ...server,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    status(value: number) {
      status = value;
    },
    async waitForSends(count: number) {
      for (let attempt = 0; attempt < 100 && sent.length < count; attempt++)
        await setTimeout(50);
      assert.equal(sent.length, count);
    },
  };
}

export async function waitForEmailLog(
  engine: { logs: () => string },
  requestId: string | null,
) {
  assert.ok(requestId);
  for (let attempt = 0; attempt < 100; attempt++) {
    const line = engine
      .logs()
      .split("\n")
      .find(
        (line) => line.includes('"inquiry.email"') && line.includes(requestId),
      );
    if (line) return JSON.parse(line);
    await setTimeout(50);
  }
  assert.fail("No inquiry email log for the receipt's Request-Id");
}
