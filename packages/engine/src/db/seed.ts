import { pathToFileURL } from "node:url";
import pg from "pg";
import { logFailure } from "../log.ts";
import { FixtureConnector } from "../connectors/fixture.ts";
import type { Fixtures } from "../connectors/fixture.ts";
import { normalize } from "../domain/normalize.ts";
import { addressProtection } from "../domain/withholding.ts";
import { upsertListing } from "./listings.ts";

export async function seed(client: pg.Client, fixtures: Fixtures) {
  await client.query("BEGIN");
  try {
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
        `INSERT INTO idx.feeds VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET refreshed_at=EXCLUDED.refreshed_at, expires_at=EXCLUDED.expires_at,
        display_blocks=EXCLUDED.display_blocks, rules_version=EXCLUDED.rules_version`,
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
    for (const record of fixtures.listings)
      await upsertListing(client, normalize(record));
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
