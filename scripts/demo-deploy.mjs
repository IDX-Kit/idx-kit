import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readConfig, checkConfig, configs } from "./check-worker-config.mjs";

const [kind, ...args] = process.argv.slice(2);
const buildOnly = new Set([
  "MIGRATION_DATABASE_URL",
  "RUNTIME_DATABASE_PASSWORD",
  "LISTING_WRITER_DATABASE_PASSWORD",
  "IDX_SECRET_KEY",
  "IDX_SYNC_FEED_TOKEN",
  "DEMO_HYPERDRIVE_ID",
  "SYNC_HYPERDRIVE_ID",
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

// Wrangler checks the shape of triggers; ranges and syntax are checked here.
function cronField(field, min, max, names = []) {
  if (field === "*") return true;
  if (field.startsWith("*,") || field.startsWith("*-")) return false;
  const valid = (value) =>
    integer(value, min, max) || names.includes(value.toUpperCase());
  return field.split(",").every((part) => {
    const match =
      /^(\*|[a-z]+|\d+)(?:-([a-z]+|\d+))?(?:\/(\d+))?$/i.exec(part);
    if (!match) return false;
    const [, start, end, step] = match;
    return (
      (start === "*" || valid(start)) &&
      (end === undefined || valid(end)) &&
      (step === undefined || integer(step, 1, max - min))
    );
  });
}

function validCron(value) {
  const fields = value.split(/[ \t]+/);
  if (fields.length !== 5 || /[\r\n]/.test(value)) return false;
  const [minute, hour, day, month, weekday] = fields;
  const months = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split(" ");
  const weekdays = "SUN MON TUE WED THU FRI SAT".split(" ");
  const lastDay = /^L-(\d+)W?$/.exec(day);
  const nearestWeekday = /^(\d+)W$/.exec(day);
  const specialWeekday = /^([a-zA-Z]{3}|\d+)(?:L|#(\d+))$/.exec(weekday);
  return (
    cronField(minute, 0, 59) &&
    cronField(hour, 0, 23) &&
    (cronField(day, 1, 31) ||
      day === "L" ||
      day === "LW" ||
      (lastDay && integer(lastDay[1], 1, 30)) ||
      (nearestWeekday && integer(nearestWeekday[1], 1, 31))) &&
    cronField(month, 1, 12, months) &&
    (cronField(weekday, 1, 7, weekdays) ||
      weekday === "L" ||
      (specialWeekday &&
        (integer(specialWeekday[1], 1, 7) ||
          weekdays.includes(specialWeekday[1].toUpperCase())) &&
        (specialWeekday[2] === undefined || integer(specialWeekday[2], 1, 5))))
  );
}

async function syncOverrides(config) {
  const json = process.env.IDX_SYNC_FEED_JSON;
  if (!json) throw new Error("Missing IDX_SYNC_FEED_JSON.");
  const { feedSettings } = await import(
    "@idx-kit/engine/src/runtime/sync-feed-settings.ts"
  );
  try {
    feedSettings.parse(JSON.parse(json));
  } catch {
    throw new Error("IDX_SYNC_FEED_JSON must contain valid feed settings.");
  }
  config.vars = { IDX_SYNC_FEED_JSON: json };
  const pages = process.env.IDX_SYNC_PAGES_PER_RUN;
  if (pages !== undefined) {
    if (!integer(pages, 1, 20))
      throw new Error("IDX_SYNC_PAGES_PER_RUN must be an integer from 1 to 20.");
    config.vars.IDX_SYNC_PAGES_PER_RUN = pages;
  }
  const schedule = process.env.IDX_SYNC_SCHEDULE;
  if (schedule !== undefined) {
    if (schedule !== "off" && !validCron(schedule))
      throw new Error("IDX_SYNC_SCHEDULE must be off or one cron expression.");
    config.triggers.crons = schedule === "off" ? [] : [schedule];
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
  if (kind === "engine" || kind === "sync") {
    const id = hyperdriveId(
      kind === "sync" ? "SYNC_HYPERDRIVE_ID" : "DEMO_HYPERDRIVE_ID",
    );
    if (kind === "engine") run("npm", ["run", "workers:contract"]);
    const { config } = await readConfig(configs[kind]);
    checkConfig(config, kind);
    if (kind === "sync") await syncOverrides(config);
    config.hyperdrive[0].id = id;
    config.main = resolve("packages/engine", config.main);
    await mkdir(".wrangler", { recursive: true });
    const prefix = kind === "sync" ? "sync" : "demo-engine";
    directory = await mkdtemp(`.wrangler/${prefix}-`);
    const path = resolve(directory, "wrangler.json");
    await writeFile(path, JSON.stringify(config));
    const generated = await readConfig(path);
    checkConfig(generated.config, kind, kind === "engine", id);
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
    throw new Error("Choose engine, site or sync.");
  }
} catch (error) {
  console.error(
    `${kind === "sync" ? "Sync" : "Demo"} deploy: ${error instanceof Error ? error.message : "Command failed."}`,
  );
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
