import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig, checkConfig } from "../../scripts/check-worker-config.mjs";
import { captureLog, registerSecret } from "../logs.ts";

test("deploy commands use checked configs and Wrangler dry runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demo-deploy-"));
  const source = "packages/engine/wrangler.jsonc";
  const original = await readFile(source, "utf8");
  const id = "1234567890abcdef1234567890abcdef";
  const env = { ...process.env, DEMO_HYPERDRIVE_ID: id };
  // These must never reach a build or Wrangler's output.
  for (const name of ["MIGRATION_DATABASE_URL", "RUNTIME_DATABASE_PASSWORD", "IDX_SECRET_KEY"]) {
    env[name] = "synthetic_deploy_credential_" + name;
    registerSecret(env[name]);
  }
  const run = (kind, variables, status) => {
    const result = spawnSync("npm", ["run", "--silent", `demo:deploy:${kind}`, "--", "--dry-run", "--outdir", join(directory, kind)], { env: variables, encoding: "utf8" });
    const log = result.stdout + result.stderr;
    captureLog("demo-deploy", log);
    assert.equal(result.status, status, "Expected deploy command exit status");
    for (const name of ["MIGRATION_DATABASE_URL", "RUNTIME_DATABASE_PASSWORD", "IDX_SECRET_KEY"])
      assert.ok(!log.includes(env[name]), "Deploy output must not contain credentials");
    return log;
  };
  try {
    assert.match(run("engine", { ...env, DEMO_HYPERDRIVE_ID: "" }, 1), /Missing DEMO_HYPERDRIVE_ID/);
    assert.match(run("engine", env, 0), new RegExp(`HYPERDRIVE.*${id}`));
    assert.equal(await readFile(source, "utf8"), original);
    const { config } = await readConfig(source);
    checkConfig(config, "engine");
    run("site", env, 0);
    const site = await readConfig("examples/demo-site/dist-worker/server/wrangler.json");
    checkConfig(site.config, "site", false);
    for (const kind of ["engine", "site"])
      assert.ok((await readFile(join(directory, kind, "index.js"), "utf8")).length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
