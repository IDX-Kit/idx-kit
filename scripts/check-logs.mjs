import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.IDX_TEST_LOG_DIR;
const names = await readdir(directory);
const forbidden = (await readFile(join(directory, "forbidden.values"), "utf8"))
  .trim()
  .split("\n");
for (const name of ["DATABASE_URL", "RUNTIME_DATABASE_URL"]) {
  const value = process.env[name];
  if (value) {
    forbidden.push(value);
    const password = new URL(value).password;
    if (password) forbidden.push(decodeURIComponent(password));
  }
}
const logs = names.filter((name) => name.endsWith(".log"));
if (!logs.length) throw new Error("No captured logs to inspect");
for (const name of logs) {
  const text = await readFile(join(directory, name), "utf8");
  if (
    forbidden.some((value) => value && text.includes(value)) ||
    /idx_secret_(?!key\b)|postgres(?:ql)?:\/\//i.test(text)
  )
    throw new Error(`Unredacted credential in captured log: ${name}`);
}
console.log(`Checked ${logs.length} captured logs for credentials.`);
