import pg from "pg";
import contract from "../../../../.generated/openapi.json" with { type: "json" };
import metadata from "../../package.json" with { type: "json" };
import { repository } from "../db/read.ts";
import type { Database } from "../db/read.ts";
import { inquiryEmailSettings } from "../domain/inquiry-email.ts";
import type { InquiryEmailEnv } from "../domain/inquiry-email.ts";
import { createApp } from "../http/app.ts";
import { failureFields, logLine } from "../log.ts";

export default {
  async fetch(
    request: Request,
    env: InquiryEmailEnv & { HYPERDRIVE: { connectionString: string } },
    context: { waitUntil(task: Promise<void>): void },
  ) {
    const client = new pg.Client({
      connectionString: env.HYPERDRIVE.connectionString,
      connectionTimeoutMillis: 1500,
      query_timeout: 2000,
      statement_timeout: 2000,
    });
    let connection: Promise<void> | undefined;
    // Connect lazily so discovery and the contract still work during an outage.
    const db: Database = {
      async query(sql, values) {
        connection ??= client.connect();
        await connection;
        return client.query(sql, values);
      },
    };
    let response: Response | undefined;
    try {
      const app = createApp(
        repository(db),
        contract,
        metadata.version,
        console.error,
        {
          settings: inquiryEmailSettings(env),
          waitUntil: (task) => context.waitUntil(task),
        },
      );
      response = await app.fetch(request);
      return response;
    } finally {
      await client.end().catch((error: unknown) => {
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
