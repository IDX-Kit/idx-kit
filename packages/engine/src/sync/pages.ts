import { mapResoRecord } from "../connectors/reso.ts";
import type { ResoConnector } from "../connectors/reso.ts";
import type { FeedNextStep } from "../db/feed-sync-outcomes.ts";
import type { ListingPageDisclosures } from "../db/listings.ts";

export interface SyncFeed {
  feedId: string;
  synthetic: boolean;
  disclosures: ListingPageDisclosures;
  connector: Pick<ResoConnector, "readPage">;
}

type PageResult = Awaited<ReturnType<ResoConnector["readPage"]>>;
type Page = Extract<PageResult, { code: "page" }>;
export type StoppedRun =
  Exclude<PageResult, Page> | { code: "write_failed"; status?: number };

export function nextStepFor(outcome: StoppedRun): FeedNextStep {
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

export function listingChangesFor({ synthetic, disclosures }: SyncFeed) {
  const blocks = disclosures.approvedListingBlocks.filter(({ id }) =>
    disclosures.requiredListingBlockIds.includes(id),
  );
  const pageBlocks = disclosures.approvedPageBlocks.filter(({ id }) =>
    disclosures.requiredPageBlockIds.includes(id),
  );
  return (records: unknown[]) => {
    // PostgreSQL supplies the ingest time when the page is written.
    const metadata = { synthetic, ingestedAt: null, blocks, pageBlocks };
    return records.map((record) => mapResoRecord(record, metadata));
  };
}

type PageReadArgs = [
  connector: SyncFeed["connector"],
  completedMark: string | null,
  nextLink: string | null,
  applyPage: (page: Page) => Promise<void>,
  rejectContinuation: () => Promise<void>,
];
type FeedRun = StoppedRun | { code: "complete"; status?: number };

export function readFeedPages(...args: PageReadArgs): Promise<FeedRun>;
export function readFeedPages(
  ...args: [...PageReadArgs, pageLimit: number | undefined]
): Promise<FeedRun | { code: "page_limit" }>;
export async function readFeedPages(
  ...args: [...PageReadArgs, pageLimit?: number]
): Promise<FeedRun | { code: "page_limit" }> {
  const [
    connector,
    completedMark,
    firstLink,
    applyPage,
    rejectContinuation,
    pageLimit,
  ] = args;
  let nextLink = firstLink;
  let applied = 0;
  while (true) {
    const page = await connector.readPage(completedMark, nextLink);
    if (page.code === "continuation_rejected" && nextLink !== null) {
      await rejectContinuation();
    }
    if (page.code !== "page") return page;
    await applyPage(page);
    nextLink = page.nextLink;
    if (nextLink === null) return { code: "complete" };
    applied += 1;
    if (applied === pageLimit) return { code: "page_limit" };
  }
}
