import { redirectFetch } from "./loopback-fetch.ts";

// Only the CI entry points install this transport.
export function routeResendToLoopback(baseUrl: string) {
  redirectFetch("https://api.resend.com/emails", baseUrl, "email");
}

if (typeof process !== "undefined" && process.env.IDX_TEST_RESEND_URL)
  routeResendToLoopback(process.env.IDX_TEST_RESEND_URL);
