// Only the CI entry points install this transport.
export function routeResendToLoopback(baseUrl: string) {
  const target = new URL(baseUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error("The email stand-in must use loopback HTTP");
  const fetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) =>
    input === "https://api.resend.com/emails"
      ? fetch(new URL("/emails", target), init)
      : fetch(input, init);
}

if (typeof process !== "undefined" && process.env.IDX_TEST_RESEND_URL)
  routeResendToLoopback(process.env.IDX_TEST_RESEND_URL);
