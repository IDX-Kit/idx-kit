// This transport is loaded only by the CI entry points.
export function routeTurnstileToLoopback(baseUrl: string) {
  const target = new URL(baseUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error("The Turnstile stand-in must use loopback HTTP");
  const fetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) =>
    input === "https://challenges.cloudflare.com/turnstile/v0/siteverify"
      ? fetch(new URL("/turnstile/v0/siteverify", target), init)
      : fetch(input, init);
}

if (typeof process !== "undefined" && process.env.IDX_TEST_TURNSTILE_URL)
  routeTurnstileToLoopback(process.env.IDX_TEST_TURNSTILE_URL);
