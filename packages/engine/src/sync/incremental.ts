import type pg from "pg";
import { mapResoRecord } from "../connectors/reso.ts";
import type { ResoConnector } from "../connectors/reso.ts";
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

// Each run uses its own connected writer client.
export async function syncIncrementally(
  client: pg.Client,
  { feedId, synthetic, disclosures, connector }: IncrementalFeed,
) {
  try {
    let { position, version } = await readFeedCheckpoint(client, feedId);
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
        await listingFeedTransaction(client, feedId, () =>
          saveFeedCheckpoint(client, feedId, { position: cleared, version }),
        );
      }
      if (page.code !== "page") return { code: page.code } as const;

      const metadata = {
        synthetic,
        ingestedAt: new Date().toISOString(),
        blocks,
        pageBlocks,
      };
      const changes = page.records.map((record) => mapResoRecord(record, metadata));
      let pendingMark = position.pendingMark;
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
        completedMark: complete
          ? (pendingMark ?? position.completedMark)
          : position.completedMark,
        nextLink: page.nextLink,
        pendingMark: complete ? null : pendingMark,
      };
      await applyListingPage(client, feedId, changes, disclosures, {
        checkpoint: { position, version },
      });
      if (complete) return { code: "complete" } as const;
      version += 1n;
    }
  } catch (error) {
    if (error instanceof FeedPositionChanged) {
      return { code: "position_changed" } as const;
    }
    return { code: "write_failed" } as const;
  }
}
