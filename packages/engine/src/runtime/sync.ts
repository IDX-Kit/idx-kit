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

async function run() {
  let args;
  try {
    args = readCommand();
  } catch {
    return fail(2, "Usage: sync incremental | scan [--remove-missing --max-removals N] | status");
  }
  let settings;
  try {
    settings = await readSyncSettings(args.command === "status");
  } catch {
    return fail(1, "Invalid sync settings. Check the feed file, writer database URL, and token requirements.");
  }
  const { feed, feedToken, connectionString } = settings;
  const { feedId, propertyUrl, synthetic, disclosures } = feed;
  try {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
    // Connection loss also rejects pending queries. Keep event text out of diagnostics.
    client.on("error", () => {});
    try {
      await client.connect();
      const state = await readFeedState(client, feedId);
      if (!state) return fail(1, "The configured feed is missing from the database.");
      if (args.command === "status") {
        process.stdout.write(`${JSON.stringify(state.status)}\n`);
        return 0;
      }
      if (args.command === "incremental" && state.waitingSeconds) {
        process.stdout.write(`${JSON.stringify({ feedId, code: "waiting", secondsLeft: state.waitingSeconds })}\n`);
        return 3;
      }
      const options = {
        feedId,
        synthetic,
        disclosures,
        connector: new ResoConnector(propertyUrl.href, feedToken!),
      };
      const result = args.command === "incremental"
        ? await syncIncrementally(client, options)
        : await syncFullScan(client, args.maxRemovals === undefined ? options : {
          ...options,
          removeMissing: true,
          maxRemovals: args.maxRemovals,
        });
      if ("outcomeSaved" in result && !result.outcomeSaved) {
        return fail(1, "Could not save the incremental outcome.");
      }
      const step = "nextStep" in result ? result.nextStep : { kind: "none" };
      const nextStep = step.kind === "retry"
        ? { kind: step.kind, afterSeconds: step.afterSeconds }
        : { kind: step.kind };
      const output = {
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
        ...("unreadableRecords" in result && { unreadableRecords: result.unreadableRecords }),
      };
      process.stdout.write(`${JSON.stringify(output)}\n`);
      if (result.code === "position_changed" || step.kind === "retry") return 3;
      return step.kind === "stop" ? 4 : 0;
    } finally {
      await client.end();
    }
  } catch {
    return fail(1, "Could not access the sync database.");
  }
}

process.exitCode = await run();
