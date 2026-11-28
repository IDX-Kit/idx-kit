import pg from "pg";
import contract from "../../../../.generated/openapi.json" with { type: "json" };
import metadata from "../../package.json" with { type: "json" };
import { repository } from "../db/read.ts";
import type { Database } from "../db/read.ts";
import { inquiryEmailSettings } from "../domain/inquiry-email.ts";
import type { InquiryEmailEnv } from "../domain/inquiry-email.ts";
import { createApp } from "../http/app.ts";
import { failureFields, logLine } from "../log.ts";

const app = createApp(undefined, contract, metadata.version);

export default {
  async fetch(
    request: Request,
    env: InquiryEmailEnv & {
      HYPERDRIVE: { connectionString: string };
      TURNSTILE_SECRET_KEY?: unknown;
    },
    context: { waitUntil(task: Promise<void>): void },
  ) {
    let client: pg.Client | undefined;
    let connection: Promise<void> | undefined;
    // Create the client only for database requests and keep it within this request.
    const db: Database = {
      async query(sql, values) {
        client ??= new pg.Client({
          connectionString: env.HYPERDRIVE.connectionString,
          connectionTimeoutMillis: 1500,
          query_timeout: 2000,
          statement_timeout: 2000,
        });
        connection ??= client.connect();
        await connection;
        return client.query(sql, values);
      },
    };
    let response: Response | undefined;
    try {
      response = await app.fetch(request, {
        db: repository(db),
        inquiryOptions: () => ({
          email: {
            settings: inquiryEmailSettings(env),
            waitUntil: (task) => context.waitUntil(task),
          },
          turnstileSecret: env.TURNSTILE_SECRET_KEY,
        }),
      });
      return response;
    } finally {
      await client?.end().catch((error: unknown) => {
        console.error(
          logLine({
            operation: "database.close",
            requestId: response?.headers.get("Request-Id"),
            ...failureFields(error),
          }),
        );
      });
    }
  },
};
