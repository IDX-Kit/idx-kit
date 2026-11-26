import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import pg from "pg";
import { parse } from "yaml";
import { repository } from "../db/read.ts";
import { inquiryEmailSettings } from "../domain/inquiry-email.ts";
import { createApp } from "../http/app.ts";
import { failureFields, logLine } from "../log.ts";

if (!process.env.RUNTIME_DATABASE_URL)
  throw new Error("RUNTIME_DATABASE_URL is required");
const emailSettings = inquiryEmailSettings({
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  INQUIRY_EMAIL_FROM: process.env.INQUIRY_EMAIL_FROM,
  INQUIRY_EMAIL_TO: process.env.INQUIRY_EMAIL_TO,
});
if (emailSettings.mode === "incomplete")
  throw new Error(
    "Set all three inquiry email settings together: RESEND_API_KEY, INQUIRY_EMAIL_FROM, and INQUIRY_EMAIL_TO.",
  );
const pool = new pg.Pool({
  connectionString: process.env.RUNTIME_DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 1500,
  query_timeout: 2000,
  statement_timeout: 2000,
});
pool.on("error", (error) => {
  console.error(
    logLine({ operation: "database.idle", ...failureFields(error) }),
  );
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
const app = createApp(
  repository(pool, () => pool.connect()),
  contract,
  version,
  console.error,
  {
    email: { settings: emailSettings },
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
  },
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
