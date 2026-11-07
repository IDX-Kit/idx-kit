import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

async function size(directory) {
  let raw = 0;
  let compressed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const child = await size(join(directory, entry.name));
      raw += child.raw;
      compressed += child.compressed;
    } else if (!entry.name.endsWith(".map") && entry.name !== "README.md") {
      const bytes = await readFile(join(directory, entry.name));
      raw += bytes.length;
      compressed += gzipSync(bytes).length;
    }
  }
  return { raw, compressed };
}
for (const directory of process.argv.slice(2)) {
  const { raw, compressed } = await size(directory);
  console.log(`${directory}: ${raw} bytes, ${compressed} gzip bytes (Free limit: 3145728).`);
  assert.ok(raw > 0 && compressed <= 3 * 1024 * 1024, "Worker must fit the Free plan");
}
