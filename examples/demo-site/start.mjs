import { engineClient, logFailure } from "./src/server/engine.ts";

try {
  await engineClient().discover();
} catch (error) {
  logFailure(error);
  console.error(
    "Demo site requires a reachable engine with API v1 and listingDetail. Check server configuration.",
  );
  process.exit(1);
}
await import("./dist/server/entry.mjs");
