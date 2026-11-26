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
export const feedSettings = z
  .strictObject({
    feedId: sourceKeySchema.refine((id) => id.trim().length > 0),
    propertyUrl: z.url().transform((value) => new URL(value)),
    pageSize: z.int().min(1).max(200).optional(),
    synthetic: z.boolean(),
    disclosures,
  })
  .refine(
    ({ propertyUrl, synthetic }) =>
      isResoAddress(propertyUrl) &&
      (synthetic || propertyUrl.protocol === "https:"),
  );
export const feedTokenSchema = z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/);
