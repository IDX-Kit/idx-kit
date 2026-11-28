import { pathToFileURL } from "node:url";
import pg from "pg";
import { logFailure } from "../log.ts";
import { FixtureConnector } from "../connectors/fixture.ts";
import type { Fixtures } from "../connectors/fixture.ts";
import { addressProtection } from "../domain/withholding.ts";
import {
  lockListingFeeds,
  updateListingFreshness,
  writeFixturePages,
} from "./listings.ts";

export async function seed(client: pg.Client, fixtures: Fixtures) {
  const feedIds = [
    ...new Set([
      ...fixtures.feeds.map((feed) => feed.id),
      ...fixtures.listings.map((listing) => listing.feedId),
    ]),
  ];
  await client.query("BEGIN");
  try {
    // Lock before a feed exists or is updated, without locking out foreign-key checks.
    await lockListingFeeds(client, feedIds);
    for (const feed of fixtures.feeds) {
      // Feed disclosures are shared: protect every withheld source address in this feed.
      const blocks = fixtures.listings
        .filter(
          (record) =>
            record.feedId === feed.id &&
            (record.source.InternetAddressDisplayYN === false ||
              record.withheldFields?.includes("address")),
        )
        .reduce(
          (blocks, record) =>
            addressProtection(record.source.Address).blocks(blocks),
          feed.blocks,
        );
      await client.query(
        `INSERT INTO idx.feeds (id, refreshed_at, expires_at, display_blocks, rules_version)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET refreshed_at=EXCLUDED.refreshed_at, expires_at=EXCLUDED.expires_at,
        display_blocks=CASE WHEN idx.feeds.applied_disclosures IS NULL
          THEN EXCLUDED.display_blocks ELSE idx.feeds.display_blocks END,
        rules_version=EXCLUDED.rules_version`,
        [
          feed.id,
          feed.refreshedAt,
          feed.expiresAt,
          JSON.stringify(blocks),
          feed.rulesVersion,
        ],
      );
    }
    for (const site of fixtures.sites) {
      await client.query(
        "INSERT INTO idx.sites VALUES ($1) ON CONFLICT DO NOTHING",
        [site.id],
      );
      for (const feedId of site.feedIds)
        await client.query(
          "INSERT INTO idx.data_licenses VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [site.id, feedId],
        );
    }
    for (const feedId of feedIds) {
      await writeFixturePages(
        client,
        feedId,
        fixtures.listings.filter((record) => record.feedId === feedId),
      );
    }
    await updateListingFreshness(client, feedIds);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await seed(client, await new FixtureConnector().read());
  } catch (error) {
    logFailure("seed.command", error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
