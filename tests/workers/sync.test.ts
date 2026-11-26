import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import ts from "typescript";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { seed } from "@idx-kit/engine/src/db/seed.ts";
import { validateResponse } from "../api/contract.ts";
import { fixtureDisclosures } from "../api/listing-page.ts";
import { keyCommand } from "../api/runtime.ts";
import { registerSecret } from "../logs.ts";
import { feedToken, page, standIn } from "../sync/feed.ts";
import { startWorker } from "./runtime.ts";

const configPath = "packages/engine/wrangler.sync.jsonc";
const port = 8790;
const explorer = `http://127.0.0.1:${port}/cdn-cgi/local/explorer/api`;
const instances = `${explorer}/workflows/idx-kit-listing-sync/instances`;

async function localRequest(url: string, body?: object) {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  assert.ok(
    response.ok && data.success,
    `Local API returned ${response.status}`,
  );
  return data.result;
}

async function deliver(time: number) {
  const result = await localRequest(
    `${explorer}/local/scheduled?worker=idx-kit-sync`,
    { cron: "*/30 * * * *", scheduled_time: time },
  );
  assert.equal(result.outcome, "ok");
  return `scheduled-${time}`;
}

async function finished(id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await localRequest(`${instances}/${id}`);
    if (["complete", "errored", "terminated"].includes(result.status))
      return result;
    await setTimeout(100);
  }
  assert.fail("Workflow did not finish");
}

async function openSyncWorker(t: TestContext, vars: Record<string, string>) {
  const directory = await mkdtemp(`${tmpdir()}/idx-worker-sync-`);
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
  const path = `${directory}/wrangler.json`;
  await writeFile(path, JSON.stringify(config));
  const bindings = Object.entries(vars).map(
    ([name, value]) => `${name}='${value}'`,
  );
  await writeFile(`${directory}/.dev.vars`, bindings.join("\n"), { mode: 0o600 });
  worker = await startWorker(path, port, {
    writer: true,
    readyPath: "/cdn-cgi/local/explorer/api/workflows",
    persistTo: `${directory}/state`,
  });
  return { worker, directory };
}

test("scheduled listing sync on Workers", { timeout: 90_000 }, async (t) => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  t.after(() => db.end());
  const fixtures = await new FixtureConnector().read();
  const [fixture] = fixtures.feeds;
  const suffix = randomUUID();
  const feedId = `feed_worker_${suffix}`;
  const siteId = `site_worker_${suffix}`;
  await seed(db, {
    feeds: [
      {
        ...fixture,
        id: feedId,
        refreshedAt: "2000-01-01T00:00:00Z",
        expiresAt: "2000-01-01T01:00:00Z",
      },
    ],
    listings: [],
    sites: [{ id: siteId, feedIds: [feedId] }],
  });
  const records = [1, 2, 3].map((number) => ({
    ...fixtures.listings[0].source,
    ListingKey: `Synthetic Worker listing ${number}`,
    ModificationTimestamp: "2026-11-03T00:00:00.000001Z",
  }));
  let reply: ReturnType<typeof page> | { status: number; retryAfter?: string };
  const feed = await standIn(t, () => {
    if (reply) return reply;
    return records;
  });
  const feedJson = JSON.stringify({
    feedId,
    propertyUrl: feed.propertyUrl,
    synthetic: true,
    pageSize: 1,
    disclosures: fixtureDisclosures(fixtures, fixture.id),
  });
  registerSecret(feedToken);
  const vars = {
    IDX_SYNC_FEED_JSON: feedJson,
    IDX_SYNC_FEED_TOKEN: feedToken,
    IDX_SYNC_PAGES_PER_RUN: "2",
  };
  const checkRedacted = (output: string, ...extra: string[]) => {
    for (const value of [feedToken, feedId, feed.propertyUrl, feedJson, ...extra])
      assert.ok(!output.includes(value), "Sync diagnostics must omit settings");
  };
  let time = Date.UTC(2026, 10, 3);
  const tick = () => deliver((time += 30 * 60 * 1000));

  await t.test("three pages across two schedules with duplicate delivery", async (t) => {
    const { worker, directory } = await openSyncWorker(t, vars);
    const engine = await startWorker("packages/engine/wrangler.jsonc", 8787);
    t.after(() => engine.stop());
    const { secret } = await keyCommand(
      directory,
      "create",
      siteId,
      "listings:read",
    );
    const path = "/api/v1/listings";
    const readApi = async (status: number) => {
      const response = await fetch(`http://127.0.0.1:8787${path}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const body = await response.json();
      assert.equal(response.status, status);
      validateResponse(path, response, body);
      return body;
    };
    const listingIds = async () => {
      const { rows } = await db.query<{ listing_id: string }>(
        "SELECT listing_id FROM idx.source_mappings WHERE feed_id=$1 ORDER BY listing_id",
        [feedId],
      );
      return rows.map(({ listing_id }) => listing_id);
    };
    const firstId = await tick();
    const first = await finished(firstId);
    checkRedacted(JSON.stringify(first));
    assert.equal(first.status, "complete");
    assert.deepEqual(first.output, {
      code: "page_limit",
      nextStep: { kind: "retry" },
      pagesApplied: 2,
    });
    assert.equal(first.steps.length, 3);
    for (const step of first.steps.slice(1)) {
      assert.deepEqual(step.output, {
        code: "page_limit",
        nextStep: { kind: "retry" },
      });
      assert.deepEqual(step.config.retries, {
        limit: 1,
        delay: "10 seconds",
        backoff: "constant",
      });
      assert.equal(step.config.timeout, "1 minute");
    }
    await deliver(time);
    const runs = await localRequest(instances);
    assert.deepEqual(runs.map(({ id }: { id: string }) => id), [firstId]);
    assert.equal(feed.calls.length, 2);
    assert.equal((await listingIds()).length, 2);
    assert.equal((await readApi(503)).code, "feed_expired");

    const last = await finished(await tick());
    checkRedacted(JSON.stringify(last));
    assert.equal(last.status, "complete");
    assert.deepEqual(last.output, {
      code: "complete",
      nextStep: { kind: "none" },
      pagesApplied: 1,
    });
    assert.deepEqual(
      feed.calls.map(({ query }) => query),
      ["", "?cursor=1", "?cursor=2"],
    );
    assert.ok(feed.calls.every(({ authorized }) => authorized));
    assert.deepEqual(feed.preferences, Array(3).fill("odata.maxpagesize=1"));
    const body = await readApi(200);
    const ids = await listingIds();
    assert.equal(ids.length, 3);
    assert.deepEqual(body.data.map(({ id }: { id: string }) => id).sort(), ids);
    checkRedacted(worker.rawLogs());
  });

  await t.test("database wait, saved stop and manual resume", async (t) => {
    await openSyncWorker(t, vars);
    const check = async (id: string, code: string, pagesApplied: number) => {
      const result = await finished(id);
      assert.equal(result.status, "complete");
      assert.equal(result.output.code, code);
      assert.equal(result.output.pagesApplied, pagesApplied);
    };
    const start = feed.calls.length;
    reply = { status: 429, retryAfter: "86400" };
    await check(await tick(), "http_error", 0);
    await check(await tick(), "waiting", 0);
    assert.equal(feed.calls.length, start + 1);
    await db.query(
      "UPDATE idx.feed_sync_outcomes SET saved_at=statement_timestamp() - interval '1 day' WHERE feed_id=$1",
      [feedId],
    );
    reply = page([]);
    await check(await tick(), "complete", 1);
    assert.equal(feed.calls.length, start + 2);

    reply = { status: 401 };
    await check(await tick(), "http_error", 0);
    await check(await tick(), "stopped", 0);
    assert.equal(feed.calls.length, start + 3);
    reply = page([]);
    const { id } = await localRequest(instances, { params: { resume: true } });
    await check(id, "complete", 1);
    assert.equal(feed.calls.length, start + 4);
  });

  const invalidJson = "{synthetic-invalid-feed-settings";
  for (const [name, json, token, pages] of [
    ["invalid JSON", invalidJson, feedToken, "2"],
    ["missing token", feedJson, undefined, "2"],
    ["zero pages", feedJson, feedToken, "0"],
    ["too many pages", feedJson, feedToken, "21"],
  ] as const) {
    await t.test(name, async (t) => {
      const count = feed.calls.length;
      const { worker } = await openSyncWorker(t, {
        IDX_SYNC_FEED_JSON: json,
        ...(token === undefined ? {} : { IDX_SYNC_FEED_TOKEN: token }),
        IDX_SYNC_PAGES_PER_RUN: pages,
      });
      const result = await finished(await tick());
      assert.equal(result.status, "errored");
      assert.equal(result.error.message, "Invalid sync settings");
      assert.equal(result.output, null);
      assert.equal(feed.calls.length, count);
      await worker.stop();
      checkRedacted(JSON.stringify(result) + worker.rawLogs(), invalidJson);
    });
  }
});
