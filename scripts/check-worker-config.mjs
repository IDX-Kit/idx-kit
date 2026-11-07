import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const configs = {
  engine: "packages/engine/wrangler.jsonc",
  site: "examples/demo-site/wrangler.jsonc",
};
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
) {
  const allowed = [
    "name",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "observability",
    ...(kind === "engine"
      ? ["main", "hyperdrive", "placement"]
      : ["routes", "services"]),
  ];
  if (source)
    assert.ok(
      Object.keys(config).every((key) => allowed.includes(key)),
      "Only approved config fields; no account, secrets, vars or overrides",
    );
  assert.equal(config.name, `idx-kit-demo-${kind}`);
  assert.equal(config.compatibility_date, "2026-11-06");
  assert.deepEqual(config.compatibility_flags, ["nodejs_compat"]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.ok(!("account_id" in config));
  assert.ok(!("route" in config));
  assert.ok(!config.vars || Object.keys(config.vars).length === 0);
  assert.ok(!config.env || Object.keys(config.env).length === 0);
  assert.equal(config.observability?.enabled, true);
  assert.notEqual(config.observability?.logs?.enabled, false);
  if (source) assert.deepEqual(config.observability, { enabled: true });
  if (kind === "engine") {
    assert.ok(!("routes" in config));
    assert.deepEqual(config.hyperdrive, [
      { binding: "HYPERDRIVE", id: hyperdriveId },
    ]);
    assert.deepEqual(config.placement, { region: "aws:us-east-1" });
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
    if (kind === "engine")
      assert.match(text, /\/\/ Placeholder for local builds only\./);
  }
  if (process.argv[2]) {
    const { config } = await readConfig(process.argv[2]);
    checkConfig(config, "site", false);
  }
  console.log("Worker exposure, logs, placement and binding checks PASS.");
}
