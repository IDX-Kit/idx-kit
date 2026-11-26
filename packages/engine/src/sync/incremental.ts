import type pg from "pg";
import { mapResoRecord } from "../connectors/reso.ts";
import type { ResoConnector } from "../connectors/reso.ts";
import { saveFeedOutcome } from "../db/feed-sync-outcomes.ts";
import type { FeedNextStep } from "../db/feed-sync-outcomes.ts";
import {
  FeedPositionChanged,
  readFeedCheckpoint,
  saveFeedCheckpoint,
} from "../db/feed-sync-positions.ts";
import {
  applyListingPage,
  listingFeedTransaction,
  revisionKey,
} from "../db/listings.ts";
import type { ListingPageDisclosures } from "../db/listings.ts";
import { timestampSchema } from "../domain/normalize.ts";

interface IncrementalFeed {
  feedId: string;
  synthetic: boolean;
  disclosures: ListingPageDisclosures;
  connector: Pick<ResoConnector, "readPage">;
}

type StoppedRun =
  | Exclude<Awaited<ReturnType<ResoConnector["readPage"]>>, { code: "page" }>
  | { code: "write_failed"; status?: number };

function nextStepFor(outcome: StoppedRun): FeedNextStep {
  if (outcome.code === "invalid_link") return { kind: "stop" };
  if (outcome.code === "http_error" && outcome.status !== undefined) {
    const { status, afterSeconds } = outcome;
    if (afterSeconds !== undefined) return { kind: "retry", afterSeconds };
    if (status !== 408 && status !== 429 && (status < 500 || status >= 600)) {
      return { kind: "stop" };
    }
  }
  return { kind: "retry" };
}

// Each run uses its own connected writer client.
export async function syncIncrementally(
  client: pg.Client,
  { feedId, synthetic, disclosures, connector }: IncrementalFeed,
) {
  let version: bigint | undefined;
  let outcome: StoppedRun | { code: "complete"; status?: number };
  try {
    const checkpoint = await readFeedCheckpoint(client, feedId);
    let { position } = checkpoint;
    version = checkpoint.version;
    const blocks = disclosures.approvedListingBlocks.filter(({ id }) =>
      disclosures.requiredListingBlockIds.includes(id),
    );
    const pageBlocks = disclosures.approvedPageBlocks.filter(({ id }) =>
      disclosures.requiredPageBlockIds.includes(id),
    );
    while (true) {
      const page = await connector.readPage(
        position.completedMark,
        position.nextLink,
      );
      if (page.code === "continuation_rejected" && position.nextLink !== null) {
        const cleared = { ...position, nextLink: null, pendingMark: null };
        const checkpoint = { position: cleared, version };
        await listingFeedTransaction(client, feedId, () =>
          saveFeedCheckpoint(client, feedId, checkpoint),
        );
        version += 1n;
      }
      if (page.code !== "page") {
        outcome = page;
        break;
      }

      const metadata = {
        synthetic,
        ingestedAt: new Date().toISOString(),
        blocks,
        pageBlocks,
      };
      const changes = page.records.map((record) =>
        mapResoRecord(record, metadata),
      );
      const savedMark = position.pendingMark;
      let pendingMark = position.completedMark;
      if (
        savedMark !== null &&
        (pendingMark === null || savedMark > pendingMark)
      ) {
        pendingMark = savedMark;
      }
      for (const { revision } of changes) {
        const timestamp = timestampSchema.safeParse(revision);
        if (!timestamp.success) continue;
        const key = revisionKey(timestamp.data);
        if (key !== null && (pendingMark === null || key > pendingMark)) {
          pendingMark = key;
        }
      }

      const complete = page.nextLink === null;
      position = {
        completedMark: complete ? pendingMark : position.completedMark,
        nextLink: page.nextLink,
        pendingMark: complete ? null : pendingMark,
      };
      await applyListingPage(client, feedId, changes, disclosures, {
        checkpoint: { position, version },
      });
      version += 1n;
      if (complete) {
        outcome = { code: "complete" };
        break;
      }
    }
  } catch (error) {
    if (error instanceof FeedPositionChanged) {
      return { code: "position_changed", nextStep: { kind: "none" } } as const;
    }
    outcome = { code: "write_failed" };
  }
  const result =
    outcome.code === "complete"
      ? ({ code: "complete" } as const)
      : { code: outcome.code, nextStep: nextStepFor(outcome) };
  if (version === undefined) return { ...result, outcomeSaved: false } as const;
  try {
    const nextStep = result.code === "complete" ? null : result.nextStep;
    await saveFeedOutcome(client, feedId, version, outcome, nextStep);
  } catch {
    return { ...result, outcomeSaved: false } as const;
  }
  return result;
}
