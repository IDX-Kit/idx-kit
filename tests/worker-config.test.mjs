import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  checkConfig,
  configs,
  readConfig,
} from "../scripts/check-worker-config.mjs";

test("Worker configs reject exposure, secrets and runtime drift", async () => {
  for (const [kind, path] of Object.entries(configs)) {
    const { config } = await readConfig(path);
    checkConfig(config, kind);
    const invalid = [
      { workers_dev: true },
      { workers_dev: undefined },
      { preview_urls: true },
      { preview_urls: undefined },
      { account_id: "synthetic-account" },
      { vars: { IDX_SECRET_KEY: "synthetic-marker" } },
      { database_password: "synthetic-marker" },
      { env: { unsafe: { workers_dev: true } } },
      { route: "synthetic.example.invalid/*" },
      { observability: { enabled: kind === "stand-in-feed" } },
      { observability: { enabled: true, logs: { enabled: false } } },
      { compatibility_flags: [] },
      { name: "changed" },
      ...(kind === "stand-in-feed"
        ? [{ routes: [] }, { hyperdrive: [] }, { main: "sync-worker.ts" }]
        : []),
      ...(kind === "engine"
        ? [
            { routes: [] },
            { routes: ["synthetic.example.invalid/*"] },
            { hyperdrive: [] },
            { hyperdrive: [{ binding: "HYPERDRIVE", id: "1".repeat(32) }] },
            {
              hyperdrive: [
                {
                  binding: "HYPERDRIVE",
                  id: "0".repeat(32),
                  localConnectionString: "synthetic-marker",
                },
              ],
            },
            { placement: undefined },
            { placement: { region: "aws:us-west-1" } },
          ]
        : []),
      ...(kind === "sync"
        ? [
            { compatibility_flags: ["nodejs_compat"] },
            { routes: [] },
            { main: "src/runtime/worker.ts" },
            { workflows: [] },
            { triggers: { crons: [] } },
            {
              hyperdrive: [{ ...config.hyperdrive[0], binding: "HYPERDRIVE" }],
            },
          ]
        : []),
      ...(kind === "site"
        ? [
            { routes: [] },
            { routes: [{ pattern: "demo.idxkit.com", custom_domain: false }] },
            {
              routes: [
                { pattern: "other.example.invalid", custom_domain: true },
              ],
            },
            { routes: [...config.routes, "synthetic.example.invalid/*"] },
            { placement: { region: "aws:us-east-1" } },
            { services: [] },
          ]
        : []),
    ];
    for (const patch of invalid)
      assert.throws(
        () => checkConfig({ ...structuredClone(config), ...patch }, kind),
        JSON.stringify(patch),
      );
  }
});

test("engine deploy dry-runs a private API against the supplied Hyperdrive", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "engine-deploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await readFile(configs.engine, "utf8");
  const id = "1234567890abcdef1234567890abcdef";
  const env = {
    ...process.env,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_METRICS: "false",
    ENGINE_HYPERDRIVE_ID: id,
    ENGINE_WORKER_NAME: "",
    DEMO_HYPERDRIVE_ID: "1".repeat(32),
    PATH: `${directory}:${process.env.PATH}`,
  };
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "RUNTIME_DATABASE_URL",
    "RUNTIME_DATABASE_PASSWORD",
    "IDX_SECRET_KEY",
  ])
    delete env[name];
  await writeFile(
    join(directory, "npx"),
    `#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [tool, action, flag, file, ...options] = process.argv.slice(2);
assert.deepEqual([tool, action, flag], ["wrangler", "deploy", "--config"]);
assert.ok(options.includes("--dry-run"));
fs.copyFileSync(file, path.join(__dirname, "generated.json"));
fs.writeFileSync(path.join(__dirname, "temporary-path"), file);
const result = spawnSync(tool, [action, flag, file, ...options], { stdio: "inherit" });
assert.ifError(result.error);
process.exitCode = result.status ?? 1;
`,
    { mode: 0o700 },
  );
  function run(settings = {}) {
    return spawnSync(
      "npm",
      [
        "run",
        "--silent",
        "engine:deploy",
        "--",
        "--dry-run",
        "--outdir",
        join(directory, "bundle"),
      ],
      { env: { ...env, ...settings }, encoding: "utf8" },
    );
  }
  const missing = run({ ENGINE_HYPERDRIVE_ID: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing ENGINE_HYPERDRIVE_ID/);
  const captured = join(directory, "generated.json");
  await assert.rejects(readFile(captured), { code: "ENOENT" });

  for (const override of ["", "example-listings-api"]) {
    const result = run({ ENGINE_WORKER_NAME: override });
    const log = result.stdout + result.stderr;
    assert.equal(result.status, 0, log);
    assert.match(log, new RegExp(`HYPERDRIVE.*${id}`));
    assert.doesNotMatch(
      log,
      /idx-kit-demo-engine|demo:(prepare|seed|key|db:migrate)/,
    );
    const { config } = await readConfig(captured);
    const name = override || "idx-kit-engine";
    checkConfig(config, "api", false, id, name);
    for (const patch of [
      { name: "idx-kit-demo-engine" },
      { workers_dev: true },
      { preview_urls: true },
      { routes: ["synthetic.example.invalid/*"] },
      { placement: { region: "aws:us-east-1" } },
      { build: { command: "npm run demo:prepare" } },
    ])
      assert.throws(() =>
        checkConfig({ ...config, ...patch }, "api", false, id, name),
      );
    const temporary = await readFile(join(directory, "temporary-path"), "utf8");
    await assert.rejects(readFile(temporary), { code: "ENOENT" });
  }
  assert.equal(await readFile(configs.engine, "utf8"), original);
});

test("hosted sync deploy checks settings and removes its temporary config", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sync-deploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const guide = await readFile(
    new URL("../docs/feed-sync.md", import.meta.url),
    "utf8",
  );
  const feed = parse(guide.match(/```yaml\n([\s\S]+?)```/)[1]);
  const input = structuredClone(feed);
  input.disclosures.approvedFeedBlocks[0].unused = "synthetic-unknown-field";
  const id = "1234567890abcdef1234567890abcdef";
  const secrets = [
    "IDX_SYNC_FEED_TOKEN",
    "LISTING_WRITER_DATABASE_PASSWORD",
    "MIGRATION_DATABASE_URL",
  ];
  const marker = "synthetic_sync_deploy_credential";
  const env = {
    ...process.env,
    SYNC_HYPERDRIVE_ID: id,
    IDX_SYNC_FEED_JSON: JSON.stringify(input),
  };
  for (const name of secrets) env[name] = marker;
  await writeFile(
    join(directory, "npx"),
    `#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const [tool, action, flag, file] = process.argv.slice(2);
assert.deepEqual([tool, action, flag], ["wrangler", "deploy", "--config"]);
for (const name of ${JSON.stringify([...secrets, "IDX_SYNC_FEED_JSON"])}) assert.equal(process.env[name], undefined);
console.log(JSON.stringify({ file, config: JSON.parse(fs.readFileSync(file, "utf8")) }));
`,
    { mode: 0o700 },
  );
  function run(settings, intercept = true) {
    const result = spawnSync(
      "npm",
      [
        "run",
        "--silent",
        "sync:deploy",
        "--",
        "--dry-run",
        "--outdir",
        directory,
      ],
      {
        env: {
          ...env,
          ...settings,
          PATH: intercept ? `${directory}:${env.PATH}` : env.PATH,
        },
        encoding: "utf8",
      },
    );
    assert.ok(!(result.stdout + result.stderr).includes(marker));
    return result;
  }
  function generated(settings = {}) {
    const result = run(settings);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const schedule = "10 7 * * mon-fri";
  const overrides = {
    IDX_SYNC_PAGES_PER_RUN: "2",
    IDX_SYNC_SCHEDULE: `  ${schedule}  `,
    IDX_SYNC_CPU_MS: "10",
  };
  const { file, config } = generated(overrides);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.deepEqual(config.hyperdrive, [
    { binding: "LISTING_WRITER_HYPERDRIVE", id },
  ]);
  const generatedFeed = JSON.parse(config.vars.IDX_SYNC_FEED_JSON);
  assert.equal(
    generatedFeed.disclosures.approvedFeedBlocks[0].unused,
    undefined,
  );
  assert.deepEqual(generatedFeed, feed);
  assert.equal(config.vars.IDX_SYNC_PAGES_PER_RUN, "2");
  assert.deepEqual(config.triggers, { crons: [schedule] });
  assert.deepEqual(config.limits, { cpu_ms: 10 });
  assert.deepEqual(generated().config.triggers, { crons: ["*/30 * * * *"] });
  assert.deepEqual(generated({ IDX_SYNC_SCHEDULE: "off" }).config.triggers, {
    crons: [],
  });
  for (const [name, value] of [
    ["SYNC_HYPERDRIVE_ID", ""],
    ["SYNC_HYPERDRIVE_ID", "0".repeat(32)],
    ["IDX_SYNC_FEED_JSON", ""],
    ["IDX_SYNC_FEED_JSON", "{"],
    ["IDX_SYNC_PAGES_PER_RUN", "21"],
    ["IDX_SYNC_SCHEDULE", "* * * * *\n* * * * *"],
    ["IDX_SYNC_CPU_MS", "9"],
    ["IDX_SYNC_CPU_MS", "300001"],
    ["IDX_SYNC_CPU_MS", "10.5"],
  ]) {
    const result = run({ [name]: value });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(name));
  }
  const dryRun = run(overrides, false);
  assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr);
});

test("the self-hosting guide stores all Worker email settings as secrets", async () => {
  const guide = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  for (const name of [
    "RESEND_API_KEY",
    "INQUIRY_EMAIL_FROM",
    "INQUIRY_EMAIL_TO",
  ])
    assert.ok(guide.includes(`wrangler secret put ${name}`));
});
