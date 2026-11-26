import type { Fixtures } from "@idx-kit/engine/src/connectors/fixture.ts";
import type { ListingPageDisclosures } from "@idx-kit/engine/src/db/listings.ts";

export function fixtureDisclosures(
  fixtures: Fixtures,
  id: string,
): ListingPageDisclosures {
  const feed = fixtures.feeds.find((feed) => feed.id === id)!;
  const listing = fixtures.listings.flatMap((record) => record.blocks);
  const page = fixtures.listings.flatMap((record) => record.pageBlocks);
  return {
    approvedFeedBlocks: feed.blocks,
    approvedListingBlocks: [
      ...new Map(listing.map((block) => [block.id, block])).values(),
    ],
    approvedPageBlocks: [
      ...new Map(page.map((block) => [block.id, block])).values(),
    ],
    requiredListingBlockIds: ["synthetic_broker"],
    requiredPageBlockIds: [],
  };
}
