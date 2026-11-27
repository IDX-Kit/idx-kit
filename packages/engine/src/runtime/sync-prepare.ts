import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrate } from "../db/migrate.ts";
import {
  LegacyDisclosuresError,
  parseFeedSettings,
} from "./sync-feed-settings.ts";

class PrepareError extends Error {}

let stage = "configuration";
async function prepare() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString))
    throw new PrepareError("MIGRATION_DATABASE_URL must be a PostgreSQL URL.");
  const password = process.env.LISTING_WRITER_DATABASE_PASSWORD;
  if (!password || password.length < 32)
    throw new PrepareError(
      "LISTING_WRITER_DATABASE_PASSWORD must have at least 32 characters.",
    );
  let feed;
  try {
    feed = parseFeedSettings(JSON.parse(process.env.IDX_SYNC_FEED_JSON ?? ""));
  } catch (error) {
    throw new PrepareError(
      error instanceof LegacyDisclosuresError
        ? error.message
        : "IDX_SYNC_FEED_JSON must contain valid feed settings.",
    );
  }

  stage = "database connection";
  const db = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  db.on("error", () => {});
  try {
    await db.connect();
    // Serialize builds for this database across the migration transaction.
    await db.query("SELECT pg_advisory_lock(711003)");
    stage = "runtime role";
    const runtime = await db.query(
      "SELECT 1 FROM pg_roles WHERE rolname='idx_runtime'",
    );
    if (!runtime.rowCount)
      await db.query(
        "CREATE ROLE idx_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION",
      );

    stage = "migrations";
    await migrate(db);

    stage = "writer role";
    await db.query("BEGIN");
    const writer = await db.query(`
      SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit
        OR rolbypassrls OR rolreplication AS unsafe,
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS member
      FROM pg_roles WHERE rolname='idx_listing_writer'
    `);
    if (writer.rows[0]?.unsafe)
      throw new PrepareError(
        "idx_listing_writer must have no elevated privileges and NOINHERIT.",
      );
    if (writer.rows[0]?.member)
      throw new PrepareError(
        "idx_listing_writer must not be granted another role.",
      );
    if (!writer.rowCount)
      await db.query(
        "CREATE ROLE idx_listing_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION",
      );
    await db.query(
      `ALTER ROLE idx_listing_writer LOGIN PASSWORD ${pg.escapeLiteral(password)}`,
    );
    stage = "writer grants";
    await db.query(
      await readFile(
        new URL("../../setup/listing-writer.sql", import.meta.url),
        "utf8",
      ),
    );

    stage = "feed registration";
    await db.query(
      `INSERT INTO idx.feeds (id, refreshed_at, expires_at, display_blocks, rules_version)
       VALUES ($1, statement_timestamp() - interval '2 hours',
         statement_timestamp() - interval '1 hour', $2, '1')
       ON CONFLICT (id) DO NOTHING`,
      [feed.feedId, JSON.stringify(feed.disclosures.approvedFeedBlocks)],
    );
    await db.query("COMMIT");
  } finally {
    await db.end();
  }
  console.log("Sync preparation passed.");
  console.log(
    JSON.stringify({ host: db.host, port: db.port, database: db.database }),
  );
}

try {
  await prepare();
} catch (error) {
  console.error(
    JSON.stringify({
      operation: stage,
      message:
        error instanceof PrepareError
          ? error.message
          : "Sync preparation failed. Check the database connection and permissions.",
    }),
  );
  process.exitCode = 1;
}
