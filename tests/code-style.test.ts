import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("formatting, statement count and package seams are enforced", () => {
  const directories: string[] = [];
  const file = (parent: string, name: string, content: string) => {
    const directory = mkdtempSync(join(parent, "style-check-"));
    directories.push(directory);
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  };
  const run = (tool: string, args: string[]) => {
    const result = spawnSync(process.execPath, [tool, ...args], {
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  const lint = (path: string, rule?: string) => {
    const result = run("node_modules/eslint/bin/eslint.js", [
      path,
      "--format",
      "json",
    ]);
    assert.equal(result.status, rule ? 1 : 0, result.stdout + result.stderr);
    const reports = JSON.parse(result.stdout);
    if (rule)
      assert.ok(
        reports.some((report: { messages: { ruleId: string }[] }) =>
          report.messages.some((message) => message.ruleId === rule),
        ),
        result.stdout,
      );
  };
  try {
    const valid = file("tests", "valid.ts", "export const value = 1;\n");
    lint(valid);
    assert.equal(
      run("node_modules/prettier/bin/prettier.cjs", ["--check", valid]).status,
      0,
    );
    lint(
      file("tests", "statements.ts", "console.log(1); console.log(2);\n"),
      "max-statements-per-line",
    );
    const unformatted = file(
      "tests",
      "unformatted.ts",
      "export const value={number:1}\n",
    );
    assert.equal(
      run("node_modules/prettier/bin/prettier.cjs", ["--check", unformatted])
        .status,
      1,
    );
    lint(
      file(
        "examples/demo-site",
        "engine.ts",
        'import "../../../packages/engine/src/http/app.ts";\n',
      ),
      "no-restricted-imports",
    );
    lint(
      file(
        "examples/demo-site",
        "engine-name.ts",
        'import "@idx-kit/engine/src/http/app.ts";\n',
      ),
      "no-restricted-imports",
    );
    lint(
      file(
        "packages/engine",
        "website.ts",
        'import "../../../examples/demo-site/src/server/engine.ts";\n',
      ),
      "no-restricted-imports",
    );
    lint(
      file(
        "packages/engine",
        "client.ts",
        'import "../../client/src/generated.ts";\n',
      ),
      "import-x/no-relative-packages",
    );
    lint(
      file(
        "examples/demo-site",
        "valid.astro",
        '---\nimport type { Listing } from "@idx-kit/client";\nconst listing: Listing | undefined = undefined;\n---\n<p>{listing?.id}</p>\n',
      ),
    );
    lint(
      file(
        "examples/demo-site",
        "engine.astro",
        '---\nimport "@idx-kit/engine/src/http/app.ts";\n---\n<p>Example</p>\n',
      ),
      "no-restricted-imports",
    );
  } finally {
    for (const directory of directories)
      rmSync(directory, { recursive: true, force: true });
  }
});
