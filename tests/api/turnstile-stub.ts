import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { registerSecret } from "../logs.ts";

// These settings and tokens are invented and only used on loopback.
export const turnstileSettings = {
  TURNSTILE_SECRET_KEY: "synthetic-turnstile-secret",
};
export const tokens = {
  valid: "synthetic-turnstile-valid",
  invalid: "synthetic-turnstile-invalid",
  slow: "synthetic-turnstile-slow",
  upstreamError: "synthetic-turnstile-upstream-error",
  internalError: "synthetic-turnstile-internal-error",
};

export async function startTurnstileStub(privateValues: string[]) {
  const checks: {
    method: string | undefined;
    path: string | undefined;
    body: Record<string, string>;
  }[] = [];
  const accepted = new Set<string>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Object.fromEntries(
      new URLSearchParams(Buffer.concat(chunks).toString()),
    );
    checks.push({ method: request.method, path: request.url, body });
    const token = body.response;
    if (token === tokens.upstreamError) {
      response.writeHead(502);
      response.end("Synthetic upstream failure");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    if (token === tokens.slow) {
      response.flushHeaders();
      return;
    }
    let code: string | undefined;
    if (body.secret !== turnstileSettings.TURNSTILE_SECRET_KEY)
      code = "invalid-input-secret";
    else if (token === tokens.internalError) code = "internal-error";
    else if (accepted.has(token)) code = "timeout-or-duplicate";
    else if (token !== tokens.valid) code = "invalid-input-response";
    if (!code) accepted.add(token);
    response.end(
      JSON.stringify({
        success: !code,
        // Echo submitted values to exercise log redaction.
        "error-codes": code ? [code, ...privateValues] : [],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  privateValues.forEach(registerSecret);
  return {
    checks,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (!server.listening) return;
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
