import assert from "node:assert/strict";
import { test } from "node:test";
import { checkConfig, configs, readConfig } from "../scripts/check-worker-config.mjs";

test("Worker configs reject exposure, secrets and runtime drift", async () => {
  for (const [kind, path] of Object.entries(configs)) {
    const { config } = await readConfig(path);
    checkConfig(config, kind);
    const invalid = [
      { workers_dev: true }, { workers_dev: undefined },
      { preview_urls: true }, { preview_urls: undefined },
      { account_id: "synthetic-account" },
      { vars: { IDX_SECRET_KEY: "synthetic-marker" } },
      { database_password: "synthetic-marker" },
      { env: { unsafe: { workers_dev: true } } },
      { route: "synthetic.example.invalid/*" },
      { observability: { enabled: false } },
      { observability: { enabled: true, logs: { enabled: false } } },
      { compatibility_flags: [] }, { name: "changed" },
      ...(kind === "engine"
        ? [ { routes: [] }, { routes: ["synthetic.example.invalid/*"] },
            { hyperdrive: [] }, { hyperdrive: [{ binding: "HYPERDRIVE", id: "1".repeat(32) }] },
            { hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32), localConnectionString: "synthetic-marker" }] },
            { placement: undefined }, { placement: { region: "aws:us-west-1" } } ]
        : [ { routes: [] }, { routes: [{ pattern: "demo.idxkit.com", custom_domain: false }] },
            { routes: [{ pattern: "other.example.invalid", custom_domain: true }] },
            { routes: [...config.routes, "synthetic.example.invalid/*"] },
            { placement: { region: "aws:us-east-1" } }, { services: [] } ]),
    ];
    for (const patch of invalid)
      assert.throws(() => checkConfig({ ...structuredClone(config), ...patch }, kind), JSON.stringify(patch));
  }
});
