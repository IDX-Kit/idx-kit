import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { isResoAddress } from "../connectors/reso.ts";
import {
  disclosureIds,
  disclosureSchema,
  sourceKeySchema,
} from "../domain/normalize.ts";

const ids = z.array(disclosureIds.element.shape.id).max(32);
const disclosures = z
  .strictObject({
    approvedFeedBlocks: disclosureSchema.min(1),
    approvedListingBlocks: disclosureSchema,
    approvedPageBlocks: disclosureSchema,
    requiredListingBlockIds: ids.min(1),
    requiredPageBlockIds: ids,
  })
  .refine(
    (value) =>
      value.requiredListingBlockIds.every((id) =>
        value.approvedListingBlocks.some((block) => block.id === id),
      ) &&
      value.requiredPageBlockIds.every((id) =>
        value.approvedPageBlocks.some((block) => block.id === id),
      ),
  );
const feedSettings = z
  .strictObject({
    feedId: sourceKeySchema.refine((id) => id.trim().length > 0),
    propertyUrl: z.url().transform((value) => new URL(value)),
    synthetic: z.boolean(),
    disclosures,
  })
  .refine(
    ({ propertyUrl, synthetic }) =>
      isResoAddress(propertyUrl) &&
      (synthetic || propertyUrl.protocol === "https:"),
  );
const path = z.string().min(1);
const token = z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/);
const database = z.url({ protocol: /^postgres(?:ql)?$/ });

export async function readSyncSettings(statusOnly: boolean) {
  const connectionString = database.parse(process.env.LISTING_WRITER_DATABASE_URL);
  const feedToken = statusOnly ? undefined : token.parse(process.env.IDX_SYNC_FEED_TOKEN);
  const file = path.parse(process.env.IDX_SYNC_FEED_FILE);
  const feed = feedSettings.parse(parse(await readFile(file, "utf8")));
  return { connectionString, feedToken, feed };
}
