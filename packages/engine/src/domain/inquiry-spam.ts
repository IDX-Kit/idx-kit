import { z } from "zod";
import { HttpProblem } from "../http/problem.ts";
import { logLine } from "../log.ts";

const siteverifyResult = z.object({
  success: z.boolean(),
  "error-codes": z.array(z.string()).optional(),
});
// Log only known codes. An upstream response could echo submitted values.
const knownCodes = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "missing-input-response",
  "invalid-input-response",
  "bad-request",
  "timeout-or-duplicate",
  "internal-error",
]);

export async function checkInquirySpam(
  setting: unknown,
  token: string | undefined,
  key: string,
  requestId: string,
  log: (line: string) => void,
) {
  if (setting === undefined) return;
  let upstreamStatus: number | null = null;
  let turnstileErrorCodes: string[] = [];
  function fail(errorType: string, rejected = false): never {
    log(
      logLine({
        operation: "inquiry.spam_check",
        outcome: "failure",
        requestId,
        errorType,
        upstreamStatus,
        turnstileErrorCodes,
      }),
    );
    throw rejected
      ? new HttpProblem(
          422,
          "spam_check_failed",
          "Complete the spam check and try again.",
        )
      : new HttpProblem(
          503,
          "service_unavailable",
          "Retry the same action when the service is available.",
        );
  }

  if (typeof setting !== "string" || !setting.trim())
    fail("ConfigurationError");
  if (!token) fail("MissingToken", true);
  if (token.length > 2048) fail("InvalidToken", true);

  const signal = AbortSignal.timeout(3000);
  let body: unknown;
  let response: Response;
  try {
    response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: setting.trim(),
          response: token,
          idempotency_key: key.slice(1, -1),
        }),
        redirect: "manual",
        signal,
      },
    );
    upstreamStatus = response.status;
    body = await response.json();
  } catch {
    if (signal.aborted) fail("TimeoutError");
    fail(upstreamStatus === null ? "NetworkError" : "TurnstileServiceError");
  }

  const result = siteverifyResult.safeParse(body);
  if (!result.success) fail("TurnstileServiceError");
  turnstileErrorCodes = (result.data["error-codes"] ?? []).filter((code) =>
    knownCodes.has(code),
  );
  if (
    turnstileErrorCodes.includes("missing-input-secret") ||
    turnstileErrorCodes.includes("invalid-input-secret")
  )
    fail("ConfigurationError");
  if (!response.ok || turnstileErrorCodes.includes("internal-error"))
    fail("TurnstileServiceError");
  if (!result.data.success) fail("RejectedToken", true);
}
