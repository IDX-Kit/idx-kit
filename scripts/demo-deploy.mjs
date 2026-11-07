import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readConfig, checkConfig } from "./check-worker-config.mjs";

const [kind, ...args] = process.argv.slice(2);
const env = { ...process.env };
for (const name of [
  "MIGRATION_DATABASE_URL",
  "RUNTIME_DATABASE_PASSWORD",
  "IDX_SECRET_KEY",
  "DEMO_HYPERDRIVE_ID",
])
  delete env[name];
function run(command, parameters) {
  const result = spawnSync(command, parameters, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (exit ${result.status}, signal ${result.signal}).`,
    );
}
let directory;
try {
  if (kind === "engine") {
    const id = process.env.DEMO_HYPERDRIVE_ID;
    if (!id) throw new Error("Missing DEMO_HYPERDRIVE_ID.");
    if (!/^[a-f0-9]{32}$/.test(id) || /^0+$/.test(id))
      throw new Error(
        "DEMO_HYPERDRIVE_ID must be a non-placeholder Hyperdrive id.",
      );
    run("npm", ["run", "workers:contract"]);
    const { config } = await readConfig("packages/engine/wrangler.jsonc");
    checkConfig(config, "engine");
    config.hyperdrive[0].id = id;
    config.main = resolve("packages/engine", config.main);
    checkConfig(config, "engine", true, id);
    await mkdir(".wrangler", { recursive: true });
    directory = await mkdtemp(".wrangler/demo-engine-");
    const path = resolve(directory, "wrangler.json");
    await writeFile(path, JSON.stringify(config));
    run("npx", ["wrangler", "deploy", "--config", path, ...args]);
  } else if (kind === "site") {
    run("npm", ["run", "workers:site:build"]);
    run("node", [
      "scripts/check-worker-config.mjs",
      "examples/demo-site/dist-worker/server/wrangler.json",
    ]);
    run("npx", [
      "wrangler",
      "deploy",
      "--config",
      "examples/demo-site/dist-worker/server/wrangler.json",
      ...args,
    ]);
  } else {
    throw new Error("Choose engine or site.");
  }
} catch (error) {
  console.error(
    `Demo deploy: ${error instanceof Error ? error.message : "Command failed."}`,
  );
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
