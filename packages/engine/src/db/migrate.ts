import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { logFailure } from "../log.ts";

export async function migrate(client: pg.Client) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(711001)");
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
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query("INSERT INTO public.schema_migrations VALUES ($1)", [
        name,
      ]);
    }
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
    await migrate(client);
  } catch (error) {
    logFailure("migrate.command", error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
