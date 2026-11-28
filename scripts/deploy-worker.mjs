import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkConfig,
  configs,
  defaultEngineName,
  readConfig,
} from "./check-worker-config.mjs";

const [kind, ...args] = process.argv.slice(2);
const installer = kind === "api";
const hyperdriveVariables = {
  api: "ENGINE_HYPERDRIVE_ID",
  engine: "DEMO_HYPERDRIVE_ID",
  sync: "SYNC_HYPERDRIVE_ID",
};
const buildOnly = new Set([
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "RUNTIME_DATABASE_PASSWORD",
  "RUNTIME_DATABASE_URL",
  "LISTING_WRITER_DATABASE_PASSWORD",
  "IDX_SECRET_KEY",
  "IDX_SYNC_FEED_JSON",
  "IDX_SYNC_FEED_TOKEN",
  ...Object.values(hyperdriveVariables),
]);
const env = {};
for (const name of Object.keys(process.env))
  if (!buildOnly.has(name)) env[name] = process.env[name];

function run(command, parameters) {
  const result = spawnSync(command, parameters, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (exit ${result.status}, signal ${result.signal}).`,
    );
}

function hyperdriveId(name) {
  const id = process.env[name];
  if (!id) throw new Error(`Missing ${name}.`);
  if (!/^[a-f0-9]{32}$/.test(id) || /^0+$/.test(id))
    throw new Error(`${name} must be a non-placeholder Hyperdrive id.`);
  return id;
}

function integer(value, min, max) {
  return /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
}

async function syncOverrides(config) {
  const json = process.env.IDX_SYNC_FEED_JSON;
  if (!json) throw new Error("Missing IDX_SYNC_FEED_JSON.");
  const { LegacyDisclosuresError, parseFeedSettings } =
    await import("@idx-kit/engine/src/runtime/sync-feed-settings.ts");
  let feed;
  try {
    feed = parseFeedSettings(JSON.parse(json));
  } catch (error) {
    if (error instanceof LegacyDisclosuresError) throw error;
    throw new Error("IDX_SYNC_FEED_JSON must contain valid feed settings.");
  }
  config.vars = { IDX_SYNC_FEED_JSON: JSON.stringify(feed) };
  const pages = process.env.IDX_SYNC_PAGES_PER_RUN;
  if (pages !== undefined) {
    if (!integer(pages, 1, 20))
      throw new Error(
        "IDX_SYNC_PAGES_PER_RUN must be an integer from 1 to 20.",
      );
    config.vars.IDX_SYNC_PAGES_PER_RUN = pages;
  }
  const schedule = process.env.IDX_SYNC_SCHEDULE;
  if (schedule !== undefined) {
    const cron = schedule.trim();
    if (!cron || /[\r\n\u2028\u2029]/.test(cron))
      throw new Error("IDX_SYNC_SCHEDULE must be one non-empty line.");
    config.triggers.crons = schedule === "off" ? [] : [cron];
  }
  const cpu = process.env.IDX_SYNC_CPU_MS;
  if (cpu !== undefined) {
    if (!integer(cpu, 10, 300000))
      throw new Error("IDX_SYNC_CPU_MS must be an integer from 10 to 300000.");
    config.limits = { cpu_ms: Number(cpu) };
  }
}

let directory;
try {
  if (Object.hasOwn(hyperdriveVariables, kind)) {
    const id = hyperdriveId(hyperdriveVariables[kind]);
    const source = installer ? "engine" : kind;
    const { config } = await readConfig(configs[source]);
    checkConfig(config, source);
    const name = process.env.ENGINE_WORKER_NAME || defaultEngineName;
    if (installer) {
      config.name = name;
      config.placement = { mode: "smart" };
      // Reconcile any routes previously configured for this Worker name.
      config.routes = [];
    }
    if (source === "engine") run("npm", ["run", "workers:contract"]);
    if (kind === "sync") await syncOverrides(config);
    config.hyperdrive[0].id = id;
    config.main = resolve("packages/engine", config.main);
    await mkdir(".wrangler", { recursive: true });
    directory = await mkdtemp(`.wrangler/${kind}-`);
    const path = resolve(directory, "wrangler.json");
    await writeFile(path, JSON.stringify(config));
    const generated = await readConfig(path);
    checkConfig(generated.config, kind, false, id, name);
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
    throw new Error("Choose api, engine, site or sync.");
  }
} catch (error) {
  console.error(
    `${installer ? "Engine" : kind === "sync" ? "Sync" : "Demo"} deploy: ${error instanceof Error ? error.message : "Command failed."}`,
  );
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
