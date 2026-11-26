import { redirectFetch } from "./loopback-fetch.ts";

// This transport is loaded only by the CI entry points.
export function routeTurnstileToLoopback(baseUrl: string) {
  redirectFetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    baseUrl,
    "Turnstile",
  );
}

if (typeof process !== "undefined" && process.env.IDX_TEST_TURNSTILE_URL)
  routeTurnstileToLoopback(process.env.IDX_TEST_TURNSTILE_URL);
