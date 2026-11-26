import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { parse, stringify } from "yaml";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import { repository } from "@idx-kit/engine/src/db/read.ts";
import { createApp } from "@idx-kit/engine/src/http/app.ts";
import { contract, validateResponse } from "../api/contract.ts";
import { keyCommand } from "../api/runtime.ts";
import { feedToken, page, standIn } from "./feed.ts";

test(
  "operator commands against a provisioned feed",
  { timeout: 60_000 },
  async (t) => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    const runtime = new pg.Client({
      connectionString: process.env.RUNTIME_DATABASE_URL,
    });
    await db.connect();
    await runtime.connect();
    t.after(async () => {
      await runtime.end();
      await db.end();
    });
    const runbook = await readFile(
      new URL("../../docs/feed-sync.md", import.meta.url),
      "utf8",
    );
    const provision = runbook.match(/```sql ci\n([\s\S]+?)```/)?.[1];
    assert.ok(provision);
    await db.query(provision);
    const directory = await mkdtemp(join(tmpdir(), "idx-sync-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { secret } = await keyCommand(
      directory,
      "create",
      "site_example",
      "listings:read",
    );
    const app = createApp(repository(runtime), contract, "test", () => {});
    const search = "/api/v1/listings";
    async function api(path = search, status = 200) {
      const response = await app.request(path, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      assert.equal(response.status, status);
      const body = await response.json();
      validateResponse(
        path === search ? search : `${search}/{listingId}`,
        response,
        body,
      );
      return status === 200 ? body.data : body;
    }

    const { listings } = await new FixtureConnector().read();
    const revision = (n: number) => `2026-11-03T00:00:00.00000${n}Z`;
    const record = (key: string, n: number, price: string) => ({
      ...listings[0].source,
      ListingKey: `Invented command listing ${key}`,
      ModificationTimestamp: revision(n),
      ListPrice: price,
    });
    const first = record("first", 1, "100.00");
    const second = record("second", 2, "200.00");
    const third = record("third", 4, "300.00");
    const edited = record("first", 3, "125.00");
    let respond: Parameters<typeof standIn>[1] = (url) => {
      switch (url.searchParams.get("cursor")) {
        case "2":
          return page([second], "?cursor=3");
        case "3":
          return page([third]);
        default:
          return page([first], "?cursor=2");
      }
    };
    const feed = await standIn(t, (url, n) => respond(url, n));
    const feedFile = join(directory, "feed.yaml");
    const config = parse(runbook.match(/```yaml\n([\s\S]+?)```/)![1]);
    config.propertyUrl = `${feed.propertyUrl}?marker=${feedToken}`;
    await writeFile(feedFile, stringify(config));

    function start(args: string[], overrides: NodeJS.ProcessEnv = {}) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        IDX_SYNC_FEED_FILE: feedFile,
        IDX_SYNC_FEED_TOKEN: feedToken,
        ...overrides,
      };
      if (args[0] === "status") delete env.IDX_SYNC_FEED_TOKEN;
      const child = spawn("npm", ["run", "--silent", "sync", "--", ...args], {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const kill = () => process.kill(-child.pid!, "SIGKILL");
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const done = once(child, "close").then(([code, signal]) => {
        assert.ok(
          [feedToken, feed.propertyUrl, "resume-marker"].every(
            (marker) => !stdout.includes(marker) && !stderr.includes(marker),
          ),
          "Command output exposed a feed value",
        );
        return { code, signal, stdout, stderr };
      });
      t.after(async () => {
        if (child.pid && child.exitCode === null && child.signalCode === null)
          kill();
        await done;
      });
      return { done, kill };
    }
    async function run(
      args: string[],
      code = 0,
      overrides?: NodeJS.ProcessEnv,
      failure?: string,
    ) {
      const result = await start(args, overrides).done;
      assert.equal(result.code, code);
      if (code === 1 || code === 2) {
        assert.match(result.stderr, /^[^\n]+\n$/);
        if (!failure) {
          assert.equal(result.stdout, "");
          return;
        }
      } else {
        assert.equal(result.stderr, "");
      }
      assert.match(result.stdout, /^\{[^\n]+\}\n$/);
      const body = JSON.parse(result.stdout);
      assert.equal(body.feedId, config.feedId);
      if (failure)
        assert.deepEqual(body, { feedId: config.feedId, code: failure });
      return body;
    }

    await t.test(
      "status without a token and first incremental load visible through the API",
      async () => {
        const before = await run(["status"]);
        assert.ok(Date.parse(before.expiresAt) < Date.now());
        assert.equal(before.completedMark, null);
        assert.equal(before.incrementalInProgress, false);
        assert.equal(before.scanNumber, null);
        assert.equal(before.recordsSeen, null);
        assert.equal(before.lastOutcome, null);
        assert.equal(feed.calls.length, 0);
        assert.equal((await api(search, 503)).code, "feed_expired");
        assert.deepEqual(await run(["incremental"]), {
          feedId: config.feedId,
          code: "complete",
          nextStep: { kind: "none" },
        });
        assert.equal(feed.calls.length, 3);
        assert.ok(feed.calls.every(({ authorized }) => authorized));
        assert.equal((await api()).length, 3);
        const after = await run(["status"]);
        assert.ok(
          Date.parse(after.refreshedAt) > Date.parse(before.refreshedAt),
        );
        assert.ok(Date.parse(after.expiresAt) > Date.now());
        assert.equal(after.completedMark, revision(4));
        assert.equal(after.incrementalInProgress, false);
        assert.equal(after.lastOutcome.code, "complete");
        assert.equal(feed.calls.length, 3);
      },
    );

    await t.test(
      "killed incremental command resumes at the committed continuation",
      async () => {
        const requests = new EventEmitter();
        const continuation = once(requests, "continuation");
        respond = (url) => {
          if (url.searchParams.has("cursor")) {
            requests.emit("continuation");
            return "stall";
          }
          return page([third], "?cursor=resume-marker");
        };
        const interrupted = start(["incremental"]);
        await Promise.race([
          continuation,
          interrupted.done.then(() =>
            assert.fail("Command exited before requesting the continuation"),
          ),
        ]);
        assert.equal((await run(["status"])).incrementalInProgress, true);
        interrupted.kill();
        assert.equal((await interrupted.done).signal, "SIGKILL");
        respond = () => page([third]);
        const offset = feed.calls.length;
        await run(["incremental"]);
        assert.deepEqual(
          feed.calls.slice(offset).map(({ query }) => query),
          ["?cursor=resume-marker"],
        );
      },
    );

    await t.test(
      "provider failures persist and an active retry delay prevents fetching",
      async () => {
        respond = () => ({ status: 429, retryAfter: "60", body: feedToken });
        const failed = await run(["incremental"], 3);
        assert.equal(failed.code, "http_error");
        assert.deepEqual(failed.nextStep, { kind: "retry", afterSeconds: 60 });
        const offset = feed.calls.length;
        const { lastOutcome } = await run(["status"]);
        const { savedAt, ...outcome } = lastOutcome;
        assert.ok(Number.isFinite(Date.parse(savedAt)));
        assert.deepEqual(outcome, {
          code: "http_error",
          httpStatus: 429,
          nextStep: "retry",
          retrySeconds: 60,
        });
        const waiting = await run(["incremental"], 3);
        assert.equal(waiting.code, "waiting");
        assert.ok(waiting.secondsLeft > 0 && waiting.secondsLeft <= 60);
        assert.equal(feed.calls.length, offset);
        await db.query(
          "UPDATE idx.feed_sync_outcomes SET saved_at = saved_at - interval '2 minutes' WHERE feed_id = $1",
          [config.feedId],
        );
        respond = () => ({ status: 401, body: feedToken });
        assert.deepEqual((await run(["incremental"], 4)).nextStep, {
          kind: "stop",
        });
        assert.equal((await run(["status"])).lastOutcome.httpStatus, 401);
        assert.equal(feed.calls.length, offset + 1);
      },
    );

    await t.test(
      "scan repairs a missed edit and removes only within the explicit limit",
      async () => {
        const missing = (await api()).find(
          (listing: { price: { amount: string } }) =>
            listing.price.amount === "200.00",
        );
        assert.ok(missing);
        respond = () => page([edited, third]);
        const repaired = await run(["scan"]);
        assert.deepEqual(repaired, {
          feedId: config.feedId,
          code: "complete",
          nextStep: { kind: "none" },
          pagesRead: 1,
          recordsSeen: 2,
          listingsRemoved: 0,
        });
        const scanned = await run(["status"]);
        assert.equal(scanned.scanNumber, "1");
        assert.equal(scanned.scanInProgress, false);
        assert.equal(scanned.recordsSeen, 2);
        assert.equal(scanned.unreadableRecords, 0);
        assert.deepEqual(
          (await api()).map((listing: typeof missing) => listing.price.amount),
          ["125.00", "200.00", "300.00"],
        );
        const blocked = await run(
          ["scan", "--remove-missing", "--max-removals", "0"],
          4,
        );
        assert.equal(blocked.code, "removal_limit_exceeded");
        assert.equal(blocked.wouldRemove, 1);
        assert.equal(blocked.maxRemovals, 0);
        assert.equal(blocked.listingsRemoved, 0);
        const detail = `${search}/${missing.id}`;
        await api(detail);
        const removed = await run([
          "scan",
          "--remove-missing",
          "--max-removals",
          "1",
        ]);
        assert.equal(removed.listingsRemoved, 1);
        assert.equal((await api(detail, 404)).code, "not_found");
      },
    );

    await t.test(
      "usage and invalid settings fail without stdout or feed requests",
      async () => {
        const offset = feed.calls.length;
        await run(["scan", "--remove-missing"], 2);
        await run(["scan", "--max-removals", "0"], 2);
        await run(["scan", "--remove-missing", "--max-removals", "1.5"], 2);
        await run(["status", "--unknown"], 2);
        await run(["incremental"], 1, { IDX_SYNC_FEED_TOKEN: "" });
        await run(["status"], 1, {
          LISTING_WRITER_DATABASE_URL: `https://${feedToken}.test`,
        });
        const database = new URL(process.env.LISTING_WRITER_DATABASE_URL!);
        database.searchParams.set("sslmode", "require");
        await run(
          ["status"],
          1,
          { LISTING_WRITER_DATABASE_URL: database.href },
          "database_failed",
        );
        await writeFile(feedFile, stringify({ ...config, synthetic: "true" }));
        await run(["status"], 1);
        config.feedId = "feed_absent";
        await writeFile(feedFile, stringify(config));
        await run(["incremental"], 1, undefined, "missing_feed");
        assert.equal(feed.calls.length, offset);
      },
    );
  },
);
