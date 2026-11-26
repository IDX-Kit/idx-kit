import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { feedSettings, feedTokenSchema } from "./sync-feed-settings.ts";

const path = z.string().min(1);
const database = z
  .string()
  .regex(/^postgres(?:ql)?:\/\/\S+$/)
  .pipe(z.url());

export async function readSyncSettings(statusOnly: boolean) {
  const connectionString = database.parse(
    process.env.LISTING_WRITER_DATABASE_URL,
  );
  const feedToken = statusOnly
    ? undefined
    : feedTokenSchema.parse(process.env.IDX_SYNC_FEED_TOKEN);
  const file = path.parse(process.env.IDX_SYNC_FEED_FILE);
  const feed = feedSettings.parse(parse(await readFile(file, "utf8")));
  return { connectionString, feedToken, feed };
}
