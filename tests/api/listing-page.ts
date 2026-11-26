import type { Fixtures } from "@idx-kit/engine/src/connectors/fixture.ts";
import type { ListingPageDisclosures } from "@idx-kit/engine/src/db/listings.ts";

export function fixtureDisclosures(fixtures: Fixtures, id: string): ListingPageDisclosures {
  const feed = fixtures.feeds.find((feed) => feed.id === id)!;
  const blocks = fixtures.listings.flatMap((record) => [
    ...record.blocks,
    ...record.pageBlocks,
  ]);
  return {
    approvedFeedBlocks: feed.blocks,
    approvedListingBlocks: [
      ...new Map(blocks.map((block) => [block.id, block])).values(),
    ],
  };
}
