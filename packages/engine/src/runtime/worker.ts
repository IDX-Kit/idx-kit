import pg from "pg";
import contract from "../../../../.generated/openapi.json" with { type: "json" };
import { version } from "../../package.json" with { type: "json" };
import { repository } from "../db/read.ts";
import type { Database } from "../db/read.ts";
import { createApp } from "../http/app.ts";
import { failureFields, logLine } from "../log.ts";

export default {
  async fetch(
    request: Request,
    env: { HYPERDRIVE: { connectionString: string } },
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
      response = await createApp(repository(db), contract, version).fetch(
        request,
      );
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
