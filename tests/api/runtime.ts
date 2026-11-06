import { captureLog, registerSecret } from "../logs.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

export const execute = promisify(execFile);
export async function keyCommand(
  directory: string,
  action: string,
  subject: string,
  scopes?: string,
  name = action,
) {
  const path = `${directory}/${name}.secret`;
  const args = [
    "run",
    "--silent",
    "demo:key",
    "--",
    action,
    subject,
    ...(scopes ? [scopes, path] : []),
  ];
  const { stdout, stderr } = await execute("npm", args).catch((error) => {
    captureLog("key", error.stderr ?? "");
    throw error;
  });
  assert.equal(stderr, "");
  const id = stdout.trim();
  if (!scopes) return { id, secret: "", path };
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const secret = (await readFile(path, "utf8")).trim();
  registerSecret(secret);
  assert.ok(/^idx_secret_[A-Za-z0-9_-]{43}$/.test(secret));
  assert.equal(
    Buffer.from(secret.slice("idx_secret_".length), "base64url").length,
    32,
  );
  assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
  return { id, secret, path };
}
export async function startEngine() {
  const child = spawn(
    process.execPath,
    ["packages/engine/src/runtime/node.ts"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    captureLog("engine", String(chunk));
  });
  const exited = once(child, "exit");
  const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
  try {
    await Promise.race([
      once(child.stdout, "data").then(([chunk]) =>
        assert.match(chunk.toString(), /Engine ready/),
      ),
      exited.then(() => {
        throw new Error("Engine exited before readiness");
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  return {
    logs: () => stderr,
    async stop() {
      child.kill("SIGTERM");
      await exited;
    },
  };
}
