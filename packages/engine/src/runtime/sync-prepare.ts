import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { parse } from "yaml";
import { migrate } from "../db/migrate.ts";
import {
  LegacyDisclosuresError,
  parseFeedSettings,
} from "./sync-feed-settings.ts";

class PrepareError extends Error {}

async function prepareRole(
  db: pg.Client,
  name: "idx_runtime" | "idx_listing_writer",
) {
  const { rows } = await db.query(
    `SELECT rolinherit,
       rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication
         OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS unsafe
     FROM pg_roles WHERE rolname=$1`,
    [name],
  );
  const role = rows[0];
  if (!role) {
    await db.query(
      `CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`,
    );
  } else if (
    role.unsafe ||
    (name === "idx_listing_writer" && role.rolinherit)
  ) {
    throw new PrepareError(
      `${name} must be a restricted login with no role memberships.`,
    );
  }
}

export async function prepareDatabase(
  db: pg.Client,
  feed: ReturnType<typeof parseFeedSettings>,
  freshnessSeconds: number,
) {
  // Hold the lock across the migration transaction and feed registration.
  await db.query("SELECT pg_advisory_lock(711003)");
  try {
    await prepareRole(db, "idx_runtime");
    await prepareRole(db, "idx_listing_writer");
    await migrate(db);
    await db.query(
      await readFile(
        new URL("../../setup/listing-writer.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.query(
      `INSERT INTO idx.feeds
         (id, refreshed_at, expires_at, display_blocks, rules_version, freshness_seconds)
       VALUES ($1, timestamptz '1900-01-01 00:00:00+00' - $3::integer * interval '1 second',
         timestamptz '1900-01-01 00:00:00+00', $2, '1', $3)
       ON CONFLICT (id) DO UPDATE SET freshness_seconds = EXCLUDED.freshness_seconds
       WHERE idx.feeds.freshness_seconds IS DISTINCT FROM EXCLUDED.freshness_seconds`,
      [
        feed.feedId,
        JSON.stringify(feed.disclosures.approvedFeedBlocks),
        freshnessSeconds,
      ],
    );
  } finally {
    await db.query("SELECT pg_advisory_unlock(711003)");
  }
}

async function prepare(fromFile: boolean) {
  const owner = fromFile ? "DATABASE_URL" : "MIGRATION_DATABASE_URL";
  const connectionString = process.env[owner];
  if (
    !connectionString ||
    !/^postgres(?:ql)?:\/\//.test(connectionString) ||
    !URL.canParse(connectionString)
  )
    throw new PrepareError(`${owner} must be a PostgreSQL URL.`);

  const seconds = process.env.IDX_SYNC_FRESHNESS_SECONDS ?? "";
  const freshnessSeconds = Number(seconds);
  if (
    !/^\d+$/.test(seconds) ||
    freshnessSeconds < 1 ||
    freshnessSeconds > 2_147_483_647
  )
    throw new PrepareError(
      "Set IDX_SYNC_FRESHNESS_SECONDS to the approved window in whole seconds (1 to 2147483647).",
    );

  const input = fromFile ? "IDX_SYNC_FEED_FILE" : "IDX_SYNC_FEED_JSON";
  let feed;
  try {
    const value = process.env[input] ?? "";
    feed = parseFeedSettings(
      fromFile ? parse(await readFile(value, "utf8")) : JSON.parse(value),
    );
  } catch (error) {
    throw new PrepareError(
      error instanceof LegacyDisclosuresError
        ? error.message
        : `Check the feed settings in ${input}.`,
    );
  }

  const db = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  db.on("error", () => {});
  try {
    await db.connect();
    await prepareDatabase(db, feed, freshnessSeconds);
  } finally {
    await db.end();
  }
  console.log("Database migrations and writer grants are current.");
  console.log("Feed registered with the approved freshness window.");
  console.log(
    "For new logins, use psql \\password for idx_runtime and idx_listing_writer.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  try {
    if (args.length && !(args.length === 1 && args[0] === "file"))
      throw new PrepareError("Set the setup inputs in the environment.");
    await prepare(args[0] === "file");
  } catch (error) {
    console.error(
      error instanceof PrepareError
        ? error.message
        : "Database setup failed. Check the database connection and permissions.",
    );
    process.exitCode = 1;
  }
}
