import { parseArgs } from "node:util";
import pg from "pg";
import { z } from "zod";
import { ResoConnector } from "../connectors/reso.ts";
import { readFeedState } from "../db/feed-sync-outcomes.ts";
import { syncFullScan } from "../sync/full-scan.ts";
import { syncIncrementally } from "../sync/incremental.ts";
import { readSyncSettings } from "./sync-settings.ts";

const limit = z.string().regex(/^\d+$/).transform(Number).pipe(z.int());

function readCommand() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "status" && command !== "incremental" && command !== "scan") {
    throw new Error();
  }
  const { values, tokens } = parseArgs({
    args,
    tokens: true,
    options: {
      "remove-missing": { type: "boolean" },
      "max-removals": { type: "string" },
    },
  });
  if (tokens.length === 0) return { command };
  if (command !== "scan" || tokens.length !== 2 || !values["remove-missing"]) {
    throw new Error();
  }
  return { command, maxRemovals: limit.parse(values["max-removals"]) };
}

function fail(code: number, message: string) {
  process.stderr.write(`${message}\n`);
  return code;
}

function print(output: object) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function failRun(feedId: string, code: string, message: string) {
  print({ feedId, code });
  return fail(1, message);
}

async function run() {
  let args;
  try {
    args = readCommand();
  } catch {
    return fail(
      2,
      "Usage: sync incremental | scan [--remove-missing --max-removals N] | status",
    );
  }
  let settings;
  let client;
  try {
    settings = await readSyncSettings(args.command === "status");
    client = new pg.Client({
      connectionString: settings.connectionString,
      connectionTimeoutMillis: 1500,
    });
  } catch {
    return fail(
      1,
      "Invalid sync settings. Check the feed file, writer database URL, and token requirements.",
    );
  }
  const { feed, feedToken } = settings;
  const { feedId, propertyUrl, synthetic, disclosures } = feed;
  // Connection loss also rejects pending queries. Keep event text out of diagnostics.
  client.on("error", () => {});
  try {
    await client.connect();
    const state = await readFeedState(client, feedId);
    if (!state) {
      return failRun(
        feedId,
        "missing_feed",
        "The configured feed is missing from the database.",
      );
    }
    if (args.command === "status") {
      print(state.status);
      return 0;
    }
    if (args.command === "incremental" && state.waitingSeconds) {
      print({
        feedId,
        code: "waiting",
        secondsLeft: state.waitingSeconds,
      });
      return 3;
    }
    const options = {
      feedId,
      synthetic,
      disclosures,
      connector: new ResoConnector(propertyUrl.href, feedToken!),
    };
    const result =
      args.command === "incremental"
        ? await syncIncrementally(client, options)
        : await syncFullScan(
            client,
            args.maxRemovals === undefined
              ? options
              : {
                  ...options,
                  removeMissing: true,
                  maxRemovals: args.maxRemovals,
                },
          );
    if ("outcomeSaved" in result && !result.outcomeSaved) {
      return failRun(
        feedId,
        "outcome_not_saved",
        "Could not save the incremental outcome.",
      );
    }
    const step = result.nextStep ?? { kind: "none" as const };
    const nextStep =
      step.kind === "retry"
        ? { kind: step.kind, afterSeconds: step.afterSeconds }
        : { kind: step.kind };
    print({
      feedId,
      code: result.code,
      nextStep,
      ...("pagesRead" in result && {
        pagesRead: result.pagesRead,
        recordsSeen: result.recordsSeen,
        listingsRemoved: result.listingsRemoved,
      }),
      ...("wouldRemove" in result && { wouldRemove: result.wouldRemove }),
      ...("maxRemovals" in result && { maxRemovals: result.maxRemovals }),
      ...("unreadableRecords" in result && {
        unreadableRecords: result.unreadableRecords,
      }),
    });
    if (result.code === "position_changed" || step.kind === "retry") return 3;
    return step.kind === "stop" ? 4 : 0;
  } catch {
    return failRun(
      feedId,
      "database_failed",
      "Could not access the sync database.",
    );
  } finally {
    await client.end();
  }
}

process.exitCode = await run();
