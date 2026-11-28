import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { parse, stringify } from "yaml";
import type { Listing } from "@idx-kit/client";
import { FixtureConnector } from "@idx-kit/engine/src/connectors/fixture.ts";
import type { ListingPageDisclosures } from "@idx-kit/engine/src/db/listings.ts";
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
    async function request(path = search, status = 200) {
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
      return body;
    }
    async function api(path = search, status = 200) {
      const body = await request(path, status);
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
    const third = {
      ...record("third", 4, "300.00"),
      InternetAddressDisplayYN: false,
    };
    const edited = record("first", 3, "125.00");
    const invalid = { ...record("invalid", 1, "125.00"), ListPrice: 125 };
    let respond: Parameters<typeof standIn>[1] = (url) => {
      switch (url.searchParams.get("cursor")) {
        case "2":
          return page([second], "?cursor=3");
        case "3":
          return page([third]);
        default:
          return page([first, invalid], "?cursor=2");
      }
    };
    const feed = await standIn(t, (url, n) => respond(url, n));
    const feedFile = join(directory, "feed.yaml");
    const config = parse(runbook.match(/```yaml\n([\s\S]+?)```/)![1]);
    config.propertyUrl = `${feed.propertyUrl}?marker=${feedToken}`;
    const movedNotice = {
      ...config.disclosures.approvedFeedBlocks[0],
      id: "moved_notice",
      text: "Invented notice shared by every listing",
    };
    config.disclosures.approvedFeedBlocks[0].text = "Invented feed file notice";
    config.disclosures.approvedPageBlocks = [movedNotice];
    await writeFile(feedFile, stringify(config));

    async function assertDisplay(disclosures: ListingPageDisclosures) {
      const {
        approvedFeedBlocks,
        approvedListingBlocks,
        approvedPageBlocks = [],
      } = disclosures;
      const expected = [...approvedFeedBlocks, ...approvedPageBlocks];
      const result = await request();
      const items = result.data as Listing[];
      assert.deepEqual(result.display.blocks, expected);
      for (const item of items) {
        const detail = await request(`${search}/${item.id}`);
        assert.deepEqual(item.display.blocks, approvedListingBlocks);
        assert.deepEqual(detail.data, item);
        assert.deepEqual(detail.display.blocks, expected);
      }
      return items;
    }

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
        assert.deepEqual(body, {
          feedId: config.feedId,
          code: failure,
          counts: { accepted: 0, rejected: 0, rejectedByCode: {} },
        });
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
        assert.equal(before.lastRun, null);
        assert.equal(feed.calls.length, 0);
        assert.equal((await api(search, 503)).code, "feed_expired");
        const counts = {
          accepted: 3,
          rejected: 1,
          rejectedByCode: { invalid_change: 1 },
        };
        assert.deepEqual(await run(["incremental"]), {
          feedId: config.feedId,
          code: "complete",
          nextStep: { kind: "none" },
          counts,
        });
        assert.equal(feed.calls.length, 3);
        assert.ok(feed.calls.every(({ authorized }) => authorized));
        assert.deepEqual(feed.preferences, [undefined, undefined, undefined]);
        assert.equal((await assertDisplay(config.disclosures)).length, 3);
        const after = await run(["status"]);
        assert.ok(
          Date.parse(after.refreshedAt) > Date.parse(before.refreshedAt),
        );
        assert.ok(Date.parse(after.expiresAt) > Date.now());
        assert.equal(after.completedMark, revision(4));
        assert.equal(after.incrementalInProgress, false);
        assert.equal(after.lastOutcome.code, "complete");
        assert.deepEqual(after.lastRun.counts, counts);
        assert.equal(after.lastRun.kind, "incremental");
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
        const pending = await run(["status"]);
        assert.equal(pending.incrementalInProgress, true);
        assert.equal(pending.lastRun.counts.accepted, 3);
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
      "a refused outcome write preserves the provider stop result",
      async () => {
        const before = await run(["status"]);
        respond = () => ({ status: 401, body: feedToken });
        const offset = feed.calls.length;
        await db.query(
          "REVOKE INSERT ON idx.feed_sync_outcomes FROM idx_listing_writer",
        );
        try {
          assert.deepEqual(await run(["incremental"], 4), {
            feedId: config.feedId,
            code: "http_error",
            nextStep: { kind: "stop" },
            outcomeSaved: false,
            counts: { accepted: 0, rejected: 0, rejectedByCode: {} },
          });
          assert.equal(feed.calls.length, offset + 1);
          const after = await run(["status"]);
          assert.deepEqual(after.lastOutcome, before.lastOutcome);
          assert.deepEqual(after.lastRun, before.lastRun);
        } finally {
          await db.query(
            "GRANT INSERT ON idx.feed_sync_outcomes TO idx_listing_writer",
          );
        }
      },
    );

    await t.test(
      "scan repairs notices and missed edits and removes only within the explicit limit",
      async () => {
        const [original, missing, withheld] = await assertDisplay(
          config.disclosures,
        );
        const newer = record("newer", 5, "400.00");
        const withdrawn = record("withdrawn", 5, "500.00");
        const withdrawal = {
          ...withdrawn,
          ModificationTimestamp: revision(6),
          StandardStatus: "Withdrawn",
        };
        respond = () => page([newer, withdrawn]);
        await run(["incremental"]);
        const [, , , current, formerlyLive] = await assertDisplay(
          config.disclosures,
        );
        const withdrawnPath = `${search}/${formerlyLive.id}`;
        respond = () => page([withdrawal]);
        await run(["incremental"]);
        assert.equal((await api(withdrawnPath, 404)).code, "not_found");

        const feedBlocks = [
          {
            ...config.disclosures.approvedFeedBlocks[0],
            text: "Updated invented feed notice",
          },
          movedNotice,
        ];
        const listingBlocks = [
          {
            id: "notice_z",
            text: "Updated invented listing notice",
            placement: "afterListing",
            prominence: "largestListingText",
          },
          {
            id: "notice_a",
            text: "Additional invented listing notice",
            placement: "adjacent",
            prominence: "medianListingText",
          },
        ];
        const pageBlocks = [
          {
            id: "notice_page_z",
            text: "Invented listing page notice",
            placement: "pageFooter",
            prominence: "medianListingText",
          },
          {
            id: "notice_page_a",
            text: "Additional invented page notice",
            placement: "pageFooter",
            prominence: "normal",
          },
        ];
        const disclosures = {
          approvedFeedBlocks: feedBlocks,
          approvedListingBlocks: listingBlocks,
          approvedPageBlocks: pageBlocks,
        };
        await writeFile(feedFile, stringify({ ...config, disclosures }));
        respond = () => page([]);
        assert.equal((await run(["incremental"])).counts.accepted, 0);
        await assertDisplay(config.disclosures);
        respond = () => page([record("first", 2, "110.00")]);
        assert.equal((await run(["incremental"])).counts.accepted, 1);
        const [polled, untouched] = await assertDisplay(config.disclosures);
        assert.equal(polled.id, original.id);
        assert.equal(polled.price?.amount, "110.00");
        assert.equal(untouched.id, missing.id);
        assert.equal(untouched.price?.amount, "200.00");
        assert.equal((await run(["status"])).scanNumber, null);

        const sameRevision = {
          ...third,
          ListPrice: "999.00",
          InternetAddressDisplayYN: true,
        };
        const older = {
          ...newer,
          ModificationTimestamp: "2026-11-02T00:00:00Z",
          ListPrice: "999.00",
        };
        const replay = { ...withdrawn, ModificationTimestamp: revision(6) };
        const remaining = [sameRevision, older, replay, invalid];
        async function assertNotices(secondPrice: string) {
          const listings = await assertDisplay(disclosures);
          assert.deepEqual(
            listings.map((listing) => listing.price?.amount),
            ["125.00", secondPrice, "300.00", "400.00"],
          );
          assert.equal(listings[0].id, original.id);
          const updated = listings.find(({ id }) => id === withheld.id);
          assert.ok(updated);
          assert.deepEqual(updated.withheldFields, ["address"]);
          assert.equal(updated.address, null);
          assert.deepEqual(updated.images, []);
          assert.equal(
            updated.display.freshness.ingestedAt,
            withheld.display.freshness.ingestedAt,
          );
          const latest = listings.find(({ id }) => id === current.id);
          assert.ok(latest);
          assert.equal(
            latest.display.freshness.sourceUpdatedAt,
            current.display.freshness.sourceUpdatedAt,
          );
          assert.equal(
            latest.display.freshness.ingestedAt,
            current.display.freshness.ingestedAt,
          );
          assert.equal((await api(withdrawnPath, 404)).code, "not_found");
        }
        await writeFile(feedFile, stringify(config));
        const waiting = new EventEmitter();
        const requested = once(waiting, "requested");
        const { promise: release, resolve } = Promise.withResolvers<void>();
        respond = async () => {
          waiting.emit("requested");
          await release;
          return page([record("second", 2, "210.00")]);
        };
        const oldPoll = start(["incremental"]);
        try {
          await Promise.race([
            requested,
            oldPoll.done.then(() => assert.fail("Poll exited before fetching")),
          ]);
          await writeFile(feedFile, stringify({ ...config, disclosures }));
          respond = (url) =>
            url.searchParams.has("cursor")
              ? { status: 503 }
              : page([edited], "?cursor=notices");
          const interrupted = await run(["scan"], 3);
          assert.equal(interrupted.code, "http_error");
          assert.equal(interrupted.pagesRead, 1);
          assert.equal((await run(["status"])).scanInProgress, true);
          await assertNotices("200.00");
        } finally {
          resolve();
        }
        const completedPoll = await oldPoll.done;
        assert.equal(completedPoll.code, 0);
        assert.equal(JSON.parse(completedPoll.stdout).counts.accepted, 1);
        await assertNotices("210.00");

        respond = (url) => {
          assert.equal(url.searchParams.get("cursor"), "notices");
          return page(remaining);
        };
        const repaired = await run(["scan"]);
        const counts = {
          accepted: 4,
          rejected: 1,
          rejectedByCode: { invalid_change: 1 },
        };
        assert.deepEqual(repaired, {
          feedId: config.feedId,
          code: "complete",
          nextStep: { kind: "none" },
          pagesRead: 1,
          recordsSeen: 4,
          listingsRemoved: 0,
          counts,
        });
        const scanned = await run(["status"]);
        assert.equal(scanned.scanNumber, "1");
        assert.equal(scanned.scanInProgress, false);
        assert.equal(scanned.recordsSeen, 5);
        assert.equal(scanned.unreadableRecords, 0);
        assert.equal(scanned.lastRun.kind, "scan");
        assert.deepEqual(scanned.lastRun.counts, counts);
        await assertNotices("210.00");
        respond = () => page([edited, ...remaining]);
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
      "incremental and scan send the page size on every request and accept larger pages",
      async () => {
        await writeFile(feedFile, stringify({ ...config, pageSize: 2 }));
        const records = [edited, second, third];
        respond = () => records;
        const offset = feed.calls.length;
        assert.equal((await run(["incremental"])).code, "complete");
        const scan = await run(["scan"]);
        assert.equal(scan.code, "complete");
        assert.equal(scan.pagesRead, 2);
        assert.equal(scan.recordsSeen, 3);
        assert.equal(feed.calls[offset + 1].query, "?cursor=2");
        assert.equal(feed.calls[offset + 3].query, "?cursor=2");
        respond = () => page(records);
        const ignored = await run(["scan"]);
        assert.equal(ignored.code, "complete");
        assert.equal(ignored.pagesRead, 1);
        assert.equal(ignored.recordsSeen, 3);
        assert.deepEqual(
          feed.preferences.slice(offset),
          Array(5).fill("odata.maxpagesize=2"),
        );
      },
    );

    await t.test(
      "incremental and scan stop a feed with endless pages and resume the saved position",
      async () => {
        for (const command of ["incremental", "scan"]) {
          const before = await run(["status"]);
          const offset = feed.calls.length;
          respond = (url) => {
            const cursor = url.searchParams.get("endless");
            const next = Number(cursor) + 1;
            return page(cursor === null ? [third] : [], `?endless=${next}`);
          };
          const accepted = { accepted: 1, rejected: 0, rejectedByCode: {} };
          const limited = await run([command], 3);
          assert.equal(limited.code, "page_limit");
          assert.deepEqual(limited.nextStep, { kind: "retry" });
          assert.deepEqual(limited.counts, accepted);
          assert.equal(feed.calls.length - offset, 1_000);
          const pending = await run(["status"]);
          assert.equal(pending.refreshedAt, before.refreshedAt);
          assert.deepEqual(pending.lastRun, before.lastRun);
          if (command === "scan") {
            assert.equal(limited.pagesRead, 1_000);
            assert.equal(limited.listingsRemoved, 0);
            assert.equal(pending.scanInProgress, true);
          } else {
            assert.equal(pending.incrementalInProgress, true);
          }

          respond = () => page([]);
          const resumed = await run([command]);
          assert.equal(resumed.code, "complete");
          assert.deepEqual(resumed.counts, accepted);
          assert.deepEqual(
            feed.calls.slice(offset + 1_000).map(({ query }) => query),
            ["?endless=1000"],
          );
        }
      },
    );

    await t.test(
      "usage and invalid settings fail without stdout or feed requests",
      async () => {
        const offset = feed.calls.length;
        await run(["scan", "--remove-missing"], 2);
        await run(["scan", "--max-removals", "0"], 2);
        await run(["scan", "--remove-missing", "--max-removals", "1.5"], 2);
        await run(["incremental", "--page-limit", "1"], 2);
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
        const legacy = {
          ...config.disclosures,
          approvedPageBlocks: [],
          requiredListingBlockIds: ["example_listing"],
          requiredPageBlockIds: [],
        };
        await writeFile(
          feedFile,
          stringify({ ...config, disclosures: legacy }),
        );
        const obsolete = await start(["status"]).done;
        assert.equal(obsolete.code, 1);
        assert.equal(obsolete.stdout, "");
        assert.match(
          obsolete.stderr,
          /Remove disclosures\.requiredListingBlockIds and disclosures\.requiredPageBlockIds/,
        );
        for (const pageSize of [0, 201, 1.5, "2"]) {
          await writeFile(feedFile, stringify({ ...config, pageSize }));
          await run(["incremental"], 1);
        }
        config.feedId = "feed_absent";
        await writeFile(feedFile, stringify(config));
        await run(["incremental"], 1, undefined, "missing_feed");
        assert.equal(feed.calls.length, offset);
      },
    );
  },
);
