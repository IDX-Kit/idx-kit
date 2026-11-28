import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const configs = {
  engine: "packages/engine/wrangler.jsonc",
  site: "examples/demo-site/wrangler.jsonc",
  sync: "packages/engine/wrangler.sync.jsonc",
  "stand-in-feed": "tests/workers/wrangler.stand-in-feed.jsonc",
};
export const defaultEngineName = "idx-kit-engine";

export async function readConfig(path) {
  const text = await readFile(path, "utf8");
  const parsed = ts.parseConfigFileTextToJson(path, text);
  assert.ok(!parsed.error, "Worker config must parse");
  assert.ok(
    !/idx_secret_|postgres(?:ql)?:\/\/|password\s*[=:]/i.test(text),
    "No credentials in config",
  );
  return { text, config: parsed.config };
}
export function checkConfig(
  config,
  kind,
  source = true,
  hyperdriveId = "00000000000000000000000000000000",
  engineName = defaultEngineName,
) {
  const installer = kind === "api";
  const engine = kind === "engine" || installer;
  const hostedSync = kind === "sync" && !source;
  const strict = source || hostedSync || engine;
  const allowed = [
    "name",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "observability",
    ...(kind === "site" ? ["routes", "services"] : ["main"]),
    ...(engine || kind === "sync" ? ["hyperdrive"] : []),
    ...(engine ? ["placement"] : []),
    ...(installer ? ["routes"] : []),
    ...(kind === "sync" ? ["triggers", "workflows"] : []),
    ...(hostedSync ? ["vars", "limits"] : []),
  ];
  if (strict)
    assert.ok(
      Object.keys(config).every((key) => allowed.includes(key)),
      "Only approved config fields",
    );
  const expectedName = ["sync", "stand-in-feed"].includes(kind)
    ? `idx-kit-${kind}`
    : `idx-kit-demo-${kind}`;
  assert.equal(config.name, installer ? engineName : expectedName);
  assert.equal(config.compatibility_date, "2026-11-06");
  assert.deepEqual(config.compatibility_flags, [
    "nodejs_compat",
    ...(kind === "sync" ? ["global_fetch_strictly_public"] : []),
  ]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.ok(!("account_id" in config));
  assert.ok(!("route" in config));
  if (hostedSync) {
    assert.ok(
      typeof config.vars?.IDX_SYNC_FEED_JSON === "string" &&
        Object.keys(config.vars).every((name) =>
          ["IDX_SYNC_FEED_JSON", "IDX_SYNC_PAGES_PER_RUN"].includes(name),
        ),
      "Only approved sync vars",
    );
    if (config.limits) assert.deepEqual(Object.keys(config.limits), ["cpu_ms"]);
  } else {
    assert.ok(!config.vars || Object.keys(config.vars).length === 0);
  }
  assert.ok(!config.env || Object.keys(config.env).length === 0);
  const observability = kind !== "stand-in-feed";
  assert.equal(config.observability?.enabled, observability);
  if (observability)
    assert.notEqual(config.observability?.logs?.enabled, false);
  if (strict) assert.deepEqual(config.observability, { enabled: observability });
  if (engine) {
    const main = "src/runtime/worker.ts";
    assert.equal(config.main, source ? main : resolve("packages/engine", main));
    if (installer) assert.deepEqual(config.routes, []);
    else assert.ok(!("routes" in config));
    assert.deepEqual(config.hyperdrive, [
      { binding: "HYPERDRIVE", id: hyperdriveId },
    ]);
    assert.deepEqual(
      config.placement,
      installer ? { mode: "smart" } : { region: "aws:us-east-1" },
    );
  } else if (kind === "sync") {
    assert.ok(!("routes" in config));
    const main = "src/runtime/sync-worker.ts";
    assert.equal(
      config.main,
      hostedSync ? resolve("packages/engine", main) : main,
    );
    if (hostedSync) {
      assert.deepEqual(Object.keys(config.triggers), ["crons"]);
      const crons = config.triggers.crons;
      assert.ok(Array.isArray(crons) && crons.length <= 1);
      assert.ok(crons.every((cron) => typeof cron === "string"));
    } else {
      assert.deepEqual(config.triggers, { crons: ["*/30 * * * *"] });
    }
    assert.deepEqual(config.workflows, [
      {
        binding: "LISTING_SYNC",
        name: "idx-kit-listing-sync",
        class_name: "ListingSync",
        concurrency: { limit: 1 },
      },
    ]);
    assert.deepEqual(config.hyperdrive, [
      { binding: "LISTING_WRITER_HYPERDRIVE", id: hyperdriveId },
    ]);
  } else if (kind === "stand-in-feed") {
    assert.equal(config.main, "stand-in-feed.ts");
    assert.ok(!("routes" in config));
  } else {
    assert.deepEqual(config.routes, [
      { pattern: "demo.idxkit.com", custom_domain: true },
    ]);
    assert.ok(!("placement" in config));
    assert.deepEqual(config.services, [
      { binding: "IDX_ENGINE", service: "idx-kit-demo-engine" },
    ]);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  for (const [kind, path] of Object.entries(configs)) {
    const { text, config } = await readConfig(path);
    checkConfig(config, kind);
    if (["engine", "sync"].includes(kind))
      assert.match(text, /\/\/ Placeholder for local builds only\./);
    if (kind === "sync") {
      const entry = resolve(dirname(path), config.main);
      const contents = await readFile(entry, "utf8");
      const ast = ts.createSourceFile(entry, contents, ts.ScriptTarget.Latest);
      const handler = ast.statements.find(ts.isExportAssignment)?.expression;
      assert.ok(handler && ts.isObjectLiteralExpression(handler));
      assert.deepEqual(
        handler.properties.map((property) => property.name?.getText(ast)),
        ["scheduled"],
      );
    }
  }
  if (process.argv[2]) {
    const { config } = await readConfig(process.argv[2]);
    checkConfig(config, "site", false);
  }
  console.log("Worker exposure, logs, placement and binding checks PASS.");
}
