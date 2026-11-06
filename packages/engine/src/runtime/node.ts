import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import pg from "pg";
import { parse } from "yaml";
import { repository } from "../db/read.ts";
import { createApp } from "../http/app.ts";

if (!process.env.RUNTIME_DATABASE_URL)
  throw new Error("RUNTIME_DATABASE_URL is required");
const pool = new pg.Pool({
  connectionString: process.env.RUNTIME_DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 1500,
  query_timeout: 2000,
  statement_timeout: 2000,
});
pool.on("error", () => {
  /* A disconnected idle client is replaced on the next request. */
});
const contract = parse(
  await readFile(
    new URL("../../../../openapi/v1/openapi.yaml", import.meta.url),
    "utf8",
  ),
);
const { version } = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const app = createApp(repository(pool), contract, version, (line) =>
  process.stderr.write(line + "\n"),
);
const server = serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port: 8787 },
  () => process.stdout.write("Engine ready\n"),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    server.close(() => {
      void pool.end();
    });
  });
