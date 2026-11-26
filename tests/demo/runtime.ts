import { startWorkerSite, workerRuntime } from "../workers/runtime.ts";
import { captureLog } from "../logs.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";

export async function startSite(
  secret: string,
  base = "http://127.0.0.1:8787",
  port = 4321,
) {
  if (workerRuntime) return startWorkerSite(secret, base, port);
  const child = spawn(process.execPath, ["start.mjs"], {
    cwd: "examples/demo-site",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      IDX_ENGINE_URL: base,
      IDX_SECRET_KEY: secret,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
    captureLog("site", String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
    captureLog("site", String(chunk));
  });
  const exited = once(child, "exit");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    if (
      await fetch(`http://127.0.0.1:${port}/`).then(
        (r) => r.ok,
        () => false,
      )
    ) {
      return {
        logs: () => logs,
        async stop() {
          child.kill("SIGTERM");
          await exited;
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  throw new Error("Site did not start: " + logs);
}
