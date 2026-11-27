import type { Fixtures } from "@idx-kit/engine/src/connectors/fixture.ts";
import type { ListingPageDisclosures } from "@idx-kit/engine/src/db/listings.ts";

export function fixtureDisclosures(
  fixtures: Fixtures,
  id: string,
): ListingPageDisclosures {
  const feed = fixtures.feeds.find((feed) => feed.id === id)!;
  return {
    approvedFeedBlocks: feed.blocks,
    approvedListingBlocks: fixtures.listings[0].blocks,
  };
}
