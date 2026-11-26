export function redirectFetch(
  source: string,
  baseUrl: string,
  provider: string,
) {
  const target = new URL(baseUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error(`The ${provider} stand-in must use loopback HTTP`);
  const destination = new URL(new URL(source).pathname, target);
  const fetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) =>
    fetch(input === source ? destination : input, init);
}
