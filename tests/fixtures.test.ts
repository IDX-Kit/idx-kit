import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('each fixture file has original synthetic provenance and a matching checksum', async () => {
  const directory = new URL('../fixtures/', import.meta.url);
  const rights = await readFile(new URL('RIGHTS.md', directory), 'utf8');
  assert.match(rights, /original synthetic data created for IDX Kit/);
  assert.match(rights, /IDX Kit maintainers/);
  assert.match(rights, /Source: invented/);
  for (const name of ['feeds.json', 'sites.json', 'listings.json']) {
    const bytes = await readFile(new URL(name, directory));
    assert.ok(rights.includes(`| ${name} | \`${createHash('sha256').update(bytes).digest('hex')}\``));
  }
});
