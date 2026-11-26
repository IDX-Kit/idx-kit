import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { validateResponse } from "./contract.ts";
import { execute, startEngine } from "./runtime.ts";

test("the packed client installs, type-checks and calls the engine", async (t) => {
  const tarball = process.env.IDX_CLIENT_TARBALL;
  assert.ok(tarball, "Set IDX_CLIENT_TARBALL to the npm pack output");
  const { stdout: files } = await execute("tar", ["-tzf", tarball]);
  assert.deepEqual(files.trim().split("\n").sort(), [
    "package/dist/LICENSE.md",
    "package/dist/generated.d.ts",
    "package/dist/generated.js",
    "package/package.json",
  ]);

  const directory = await mkdtemp(join(tmpdir(), "idx-client-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { cwd: directory };
  await writeFile(join(directory, "package.json"), '{"private":true}\n');
  await execute(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    options,
  );
  await writeFile(
    join(directory, "discover.mts"),
    `import { configure, discoverServer, type DiscoveryResponse } from "@idx-kit/client";

configure({ serverUrl: "http://127.0.0.1:8787", timeout: 5000 });
const { data, response } = await discoverServer({}, { envelope: true });
const body: DiscoveryResponse = data;
console.log(JSON.stringify({ body, status: response.status, headers: [...response.headers] }));
`,
  );
  await execute(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--strict",
      "--module",
      "NodeNext",
      "--target",
      "ES2023",
      "discover.mts",
    ],
    options,
  );

  const engine = await startEngine();
  t.after(() => engine.stop());
  const { stdout } = await execute(process.execPath, ["discover.mjs"], options);
  const { body, status, headers } = JSON.parse(stdout);
  assert.equal(status, 200);
  validateResponse("/api", new Response(null, { status, headers }), body);
  assert.ok(
    body.data.supportedVersions.some(
      (version: { major: string }) => version.major === "v1",
    ),
  );
});
