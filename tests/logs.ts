import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export function captureLog(name: string, text: string) {
  const directory = process.env.IDX_TEST_LOG_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, name + ".log"), text);
}
export function registerSecret(secret: string) {
  const directory = process.env.IDX_TEST_LOG_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  appendFileSync(
    join(directory, "forbidden.values"),
    secret + "\n" + createHash("sha256").update(secret).digest("hex") + "\n",
  );
}
