import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { logFailure } from "../log.ts";

export async function migrate(client: pg.Client) {
  // Keep the lock across the transaction boundary needed for concurrent indexes.
  await client.query("SELECT pg_advisory_lock(711001)");
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY)",
    );
    const directory = new URL("../../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const applied = await client.query(
        "SELECT 1 FROM public.schema_migrations WHERE name = $1",
        [name],
      );
      if (applied.rowCount) continue;
      const sql = await readFile(new URL(name, directory), "utf8");
      const index = /^\d+_([a-z][a-z0-9_]*)\.index\.sql$/.exec(name)?.[1];
      if (index) {
        await client.query("COMMIT");
        await buildIndex(client, `idx.${pg.escapeIdentifier(index)}`, sql);
        await client.query("BEGIN");
      } else {
        await client.query(sql);
      }
      await client.query("INSERT INTO public.schema_migrations VALUES ($1)", [
        name,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(711001)");
  }
}

async function buildIndex(client: pg.Client, name: string, sql: string) {
  // A concurrent build interrupted before recording can leave a valid or invalid index.
  const { rows } = await client.query<{ indisvalid: boolean }>(
    "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)",
    [name],
  );
  const [index] = rows;
  if (index?.indisvalid) return;
  if (index) await client.query(`DROP INDEX CONCURRENTLY ${name}`);
  await client.query(sql);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await migrate(client);
  } catch (error) {
    logFailure("migrate.command", error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
