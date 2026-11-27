import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import ts from "typescript";
import { ResoConnector } from "@idx-kit/engine/src/connectors/reso.ts";
import { registerSecret } from "../logs.ts";
import { feedToken } from "../sync/feed.ts";
import {
  initialRevision,
  propertyPath,
  sourceKey,
} from "../sync/stand-in-records.ts";
import { startWorker } from "./runtime.ts";

const configPath = "tests/workers/wrangler.stand-in-feed.jsonc";
const port = 8791;
const base = `http://127.0.0.1:${port}`;
const propertyUrl = `${base}${propertyPath}`;
const headers = { Authorization: `Bearer ${feedToken}` };

async function openFeed(t: TestContext, token?: string, count?: string) {
  const directory = await mkdtemp(`${tmpdir()}/idx-worker-feed-`);
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  t.after(async () => {
    await worker?.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const { config } = ts.parseConfigFileTextToJson(
    configPath,
    await readFile(configPath, "utf8"),
  );
  config.main = resolve(dirname(configPath), config.main);
  if (count !== undefined) config.vars = { IDX_STAND_IN_LISTING_COUNT: count };
  const path = `${directory}/wrangler.json`;
  await writeFile(path, JSON.stringify(config));
  if (token !== undefined) {
    registerSecret(token);
    await writeFile(
      `${directory}/.dev.vars`,
      `IDX_STAND_IN_FEED_TOKEN=${token}\n`,
      { mode: 0o600 },
    );
  }
  worker = await startWorker(path, port, {
    hyperdrive: false,
    readyPath: propertyPath,
    readyStatus: 401,
  });
  return worker;
}

async function readAll(
  size: number,
  count: number,
  mark: string | null = null,
) {
  const connector = new ResoConnector(propertyUrl, feedToken, undefined, size);
  const records: unknown[] = [];
  let link: string | null = null;
  for (let start = 0; start < count; start += size) {
    const result = await connector.readPage(mark, link);
    assert.equal(result.code, "page");
    assert.equal(result.records.length, Math.min(size, count - start));
    records.push(...result.records);
    link = result.nextLink;
    assert.equal(link === null, start + size >= count);
  }
  return records;
}

test("the connector reads all listings at page sizes 25 and 100", async (t) => {
  await openFeed(t, feedToken);
  const records = await readAll(25, 300);
  assert.deepEqual(await readAll(100, 300), records);
  assert.deepEqual(
    records.map((record) => (record as { ListingKey: string }).ListingKey),
    Array.from({ length: 300 }, (_, index) => sourceKey(index + 1)),
  );
  assert.deepEqual(
    await readAll(100, 300, "2026-11-03T00:00:00.000000Z"),
    records,
  );
  const { ModificationTimestamp: mark } = records.at(-1) as {
    ModificationTimestamp: string;
  };
  assert.equal(mark, initialRevision);
  const connector = new ResoConnector(propertyUrl, feedToken, undefined, 25);
  assert.deepEqual(await connector.readPage(mark, null), {
    code: "page",
    records: [],
    nextLink: null,
  });
});

test("the stand-in enforces access, page size and no-store", async (t) => {
  const worker = await openFeed(t, feedToken, "201");
  const first = await fetch(propertyUrl, {
    headers: { ...headers, Prefer: "odata.maxpagesize=250" },
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  const firstPage = await first.json();
  assert.equal(firstPage.value.length, 200);
  assert.equal(firstPage.value[0].Images.length, 40);
  assert.equal(
    firstPage.value[0].Images[0].url,
    "https://images.example.test/property/1.jpg",
  );
  assert.equal(firstPage["@odata.nextLink"], "?cursor=200");
  const last = await fetch(new URL(firstPage["@odata.nextLink"], propertyUrl), {
    headers,
  });
  assert.equal(last.status, 200);
  assert.equal(last.headers.get("Cache-Control"), "no-store");
  const lastPage = await last.json();
  assert.equal(lastPage.value.length, 1);
  assert.equal(lastPage.value[0].ListingKey, sourceKey(201));
  assert.equal(lastPage["@odata.nextLink"], undefined);

  for (const [url, init, status, body] of [
    [propertyUrl, {}, 401, "Unauthorized"],
    [
      propertyUrl,
      { headers: { Authorization: "Bearer wrong-token" } },
      401,
      "Unauthorized",
    ],
    [propertyUrl, { headers: { Authorization: "Basic wrong-token" } }, 401, ""],
    [`${base}/other`, { headers }, 404, "404 Not Found"],
    [propertyUrl, { method: "POST", headers }, 405, ""],
    [propertyUrl, { method: "HEAD", headers }, 405, ""],
  ] as const) {
    const response = await fetch(url, init);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), body);
  }
  for (const value of [feedToken, sourceKey(1)]) {
    assert.ok(!worker.rawLogs().includes(value), "Worker logs omit feed data");
  }
});

test("the stand-in is closed when its secret is unset", async (t) => {
  await openFeed(t);
  const response = await fetch(propertyUrl, { headers });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(await response.text(), "Unauthorized");
});
