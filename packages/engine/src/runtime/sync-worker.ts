import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import pg from "pg";
import { z } from "zod";
import { ResoConnector } from "../connectors/reso.ts";
import { readFeedState, saveFeedOutcome } from "../db/feed-sync-outcomes.ts";
import { readFeedCheckpoint } from "../db/feed-sync-positions.ts";
import { syncIncrementally } from "../sync/incremental.ts";
import { feedSettings, feedTokenSchema } from "./sync-feed-settings.ts";

interface SyncEnv {
  IDX_SYNC_FEED_JSON?: string;
  IDX_SYNC_FEED_TOKEN?: string;
  IDX_SYNC_PAGES_PER_RUN?: string;
  LISTING_WRITER_HYPERDRIVE: { connectionString: string };
  LISTING_SYNC: {
    createBatch(options: {
      instances: { id: string }[];
    }): Promise<{ errors: { code: number }[] }>;
  };
}

type SyncParams = { resume?: boolean };

const pageCount = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.int().min(1).max(20));
const pageStep = {
  retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
  timeout: "1 minute",
} as const;

function settings(env: SyncEnv) {
  try {
    const json = z.string().parse(env.IDX_SYNC_FEED_JSON);
    return {
      feed: feedSettings.parse(JSON.parse(json)),
      token: feedTokenSchema.parse(env.IDX_SYNC_FEED_TOKEN),
      pages: pageCount.parse(env.IDX_SYNC_PAGES_PER_RUN ?? "10"),
    };
  } catch {
    throw new Error("Invalid sync settings");
  }
}

async function withWriter<T>(
  env: SyncEnv,
  operation: (client: pg.Client) => Promise<T>,
): Promise<T> {
  try {
    const client = new pg.Client({
      connectionString: env.LISTING_WRITER_HYPERDRIVE.connectionString,
      connectionTimeoutMillis: 5000,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      return await operation(client);
    } finally {
      await client.end();
    }
  } catch {
    throw new Error("Sync database operation failed");
  }
}

export class ListingSync extends WorkflowEntrypoint<SyncEnv, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    const { feed, token, pages } = settings(this.env);
    if (event.payload?.resume === true) {
      await step.do(
        "clear saved feed hold",
        { ...pageStep, retries: { ...pageStep.retries, limit: 0 } },
        () =>
          withWriter(this.env, async (client) => {
            const state = await readFeedState(client, feed.feedId);
            if (!state) return;
            const { version } = await readFeedCheckpoint(client, feed.feedId);
            await saveFeedOutcome(
              client,
              feed.feedId,
              version,
              { code: "resumed" },
              { kind: "retry" },
            );
          }),
      );
    }

    let last;
    let pagesApplied = 0;
    do {
      last = await step.do(
        `apply page ${pagesApplied + 1}`,
        pageStep,
        async () => {
          const result = await withWriter(this.env, async (client) => {
            const state = await readFeedState(client, feed.feedId);
            if (!state) {
              return {
                code: "missing_feed",
                nextStep: { kind: "stop" },
              } as const;
            }
            if (state.waitingSeconds) {
              return {
                code: "waiting",
                nextStep: {
                  kind: "retry",
                  afterSeconds: state.waitingSeconds,
                },
              } as const;
            }
            if (state.status.lastOutcome?.nextStep === "stop") {
              return { code: "stopped", nextStep: { kind: "stop" } } as const;
            }
            const connector = new ResoConnector(
              feed.propertyUrl.href,
              token,
              undefined,
              feed.pageSize,
            );
            return syncIncrementally(client, { ...feed, connector }, 1);
          });
          if ("outcomeSaved" in result && result.outcomeSaved === false)
            throw new NonRetryableError("Could not save sync outcome");
          return {
            code: result.code,
            nextStep: result.nextStep ?? { kind: "none" },
          };
        },
      );
      if (last.code === "page_limit" || last.code === "complete")
        pagesApplied++;
    } while (last.code === "page_limit" && pagesApplied < pages);
    return { ...last, pagesApplied };
  }
}

export default {
  async scheduled(event: { scheduledTime: number }, env: SyncEnv) {
    try {
      const { errors } = await env.LISTING_SYNC.createBatch({
        instances: [{ id: `scheduled-${event.scheduledTime}` }],
      });
      // The batch API reports an existing instance without throwing.
      if (errors.every(({ code }) => code === 10405)) return;
    } catch {
      // The platform's exception may include request details.
    }
    throw new Error("Could not start listing sync");
  },
};
