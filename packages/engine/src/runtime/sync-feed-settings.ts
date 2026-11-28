import { z } from "zod";
import { isResoAddress } from "../connectors/reso.ts";
import { listingDisclosures, sourceKeySchema } from "../domain/normalize.ts";

const feedSettings = z
  .strictObject({
    feedId: sourceKeySchema.refine((id) => id.trim().length > 0),
    propertyUrl: z.url().transform((value) => new URL(value)),
    pageSize: z.int().min(1).max(200).optional(),
    synthetic: z.boolean(),
    disclosures: listingDisclosures,
  })
  .refine(
    ({ propertyUrl, synthetic }) =>
      isResoAddress(propertyUrl) &&
      (synthetic || propertyUrl.protocol === "https:"),
  );
export const feedTokenSchema = z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/);

export class LegacyDisclosuresError extends Error {
  constructor() {
    super(
      "Remove disclosures.requiredListingBlockIds and disclosures.requiredPageBlockIds. List the blocks to display in disclosures.approvedListingBlocks and optional disclosures.approvedPageBlocks.",
    );
  }
}

export function parseFeedSettings(value: unknown) {
  const result = feedSettings.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    if (
      issue.code === "unrecognized_keys" &&
      issue.path[0] === "disclosures" &&
      issue.keys.some(
        (key) =>
          key === "requiredListingBlockIds" || key === "requiredPageBlockIds",
      )
    ) {
      throw new LegacyDisclosuresError();
    }
  }
  throw result.error;
}
