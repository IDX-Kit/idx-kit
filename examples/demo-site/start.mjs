import { engineClient, logFailure } from "./src/server/engine.ts";
import { writeLog } from "./src/server/log.ts";

try {
  await engineClient().discover();
} catch (error) {
  logFailure(error);
  writeLog({
    event: "demo_start_failed",
    message:
      "Demo site requires a reachable engine with API v1 and listingDetail. Check server configuration.",
  });
  process.exit(1);
}
await import("./dist/server/entry.mjs");
