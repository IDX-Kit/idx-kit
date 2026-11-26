import { text } from "node:stream/consumers";
import { registerSecret } from "../logs.ts";
import { listenOnLoopback } from "./loopback-server.ts";

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
  const server = await listenOnLoopback(async (request, response) => {
    const body = Object.fromEntries(new URLSearchParams(await text(request)));
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
  privateValues.forEach(registerSecret);
  return { checks, ...server };
}
