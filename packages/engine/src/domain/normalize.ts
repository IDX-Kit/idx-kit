import type { Listing, DisplayBlock } from "@idx-kit/client";
import { z } from "zod";
import { addressProtection } from "./withholding.ts";

const text = z
  .string()
  .refine((value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
export const sourceKeySchema = text.min(1);
const boundedText = text.refine((value) => Buffer.byteLength(value) <= 1024);
export const timestampSchema = z.iso
  .datetime()
  .refine((value) => !value.startsWith("0000") && value.length <= 27);
const imageFields = z.object({
  alt: boundedText.min(1),
  url: text.max(2048),
});
const mediaUrl = imageFields.shape.url.refine((value) => {
  if (/[\s\\]/.test(value) || /%(?![\da-f]{2})/i.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password;
});
const imageSchema = imageFields.extend({ url: mediaUrl });
export const genericPhotoAlt = "Property photo";
const photoInput = imageFields.extend({
  alt: z
    .string()
    .nullish()
    .transform((value) => (value?.trim() ? value : genericPhotoAlt))
    .pipe(boundedText),
});
const hiddenPhotoInput = photoInput.extend({
  alt: z.unknown().optional().transform(() => genericPhotoAlt),
});
// RESO StandardStatus lookup values in the lowercase form used by fixtures.
const standardStatuses = new Set([
  "active",
  "active under contract",
  "canceled",
  "closed",
  "coming soon",
  "delete",
  "expired",
  "hold",
  "incomplete",
  "pending",
  "withdrawn",
]);
const blockSchema = z.object({
  id: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  text: text.min(1).max(8192),
  placement: z.enum(["adjacent", "afterListing", "pageFooter"]),
  prominence: z.enum(["normal", "medianListingText", "largestListingText"]),
  image: imageSchema.optional(),
});
export const addressSchema = z.object({
  line1: boundedText,
  city: boundedText,
  region: boundedText,
  postalCode: boundedText,
  country: z.string().regex(/^[A-Z]{2}$/),
});
export const disclosureSchema = z.array(blockSchema).max(32);
export const disclosureIds = z
  .array(z.object({ id: blockSchema.shape.id }))
  .max(32);
const imagesSchema = z.array(imageSchema).max(128).nullable();
const fieldsSchema = z
  .array(z.enum(["status", "price", "address", "bedrooms", "images"]))
  .max(5);
export type WithheldField = z.infer<typeof fieldsSchema>[number];

export interface ListingRecord {
  synthetic: boolean;
  withheldFields?: WithheldField[];
  sourceUpdatedAt: string | null;
  ingestedAt: string;
  blocks: DisplayBlock[];
  pageBlocks: DisplayBlock[];
  source: {
    ListingKey: string;
    StandardStatus: Listing["status"];
    ListPrice: string | null;
    BedroomsTotal: Listing["bedrooms"];
    Address: Listing["address"];
    Images: z.input<typeof photoInput>[] | null;
    InternetAddressDisplayYN: boolean;
    InternetEntireListingDisplayYN: boolean;
  };
}
export interface FixtureRecord extends ListingRecord {
  feedId: string;
  publicId: string;
  synthetic: true;
}

export function normalize(record: ListingRecord, feedPage = false) {
  const source = record.source;
  for (const name of [
    "ListingKey",
    "StandardStatus",
    "ListPrice",
    "BedroomsTotal",
    "Address",
    "Images",
    "InternetAddressDisplayYN",
    "InternetEntireListingDisplayYN",
  ]) {
    if (!Object.hasOwn(source, name))
      throw new Error(`Missing required source fact: ${name}`);
  }
  if (!sourceKeySchema.safeParse(source.ListingKey).success)
    throw new Error("Invalid source key");
  if (
    typeof record.synthetic !== "boolean" ||
    !timestampSchema.safeParse(record.ingestedAt).success ||
    !timestampSchema.nullable().safeParse(record.sourceUpdatedAt).success
  )
    throw new Error("Invalid listing metadata");
  if (
    source.ListPrice !== null &&
    (typeof source.ListPrice !== "string" ||
      !/^(0|[1-9][0-9]{0,63})(\.[0-9]{1,32})?$/.test(source.ListPrice))
  )
    throw new Error("Invalid price");
  if (
    !feedPage &&
    source.StandardStatus !== null &&
    !boundedText.safeParse(source.StandardStatus).success
  )
    throw new Error("Invalid status");
  if (
    source.BedroomsTotal !== null &&
    (!Number.isSafeInteger(source.BedroomsTotal) || source.BedroomsTotal < 0)
  )
    throw new Error("Invalid bedrooms");
  if (
    typeof source.InternetAddressDisplayYN !== "boolean" ||
    typeof source.InternetEntireListingDisplayYN !== "boolean"
  )
    throw new Error("Missing display permission");
  const address = addressSchema.nullable().parse(source.Address);
  const fields = new Set(fieldsSchema.optional().parse(record.withheldFields));
  const hideAddress = !source.InternetAddressDisplayYN || fields.has("address");
  const protection = addressProtection(
    hideAddress && !feedPage ? address : null,
  );
  const photoSchema = feedPage ? (hideAddress ? hiddenPhotoInput : photoInput) : imageFields;
  const photos = z.array(photoSchema).max(128).nullable().parse(source.Images);
  const images =
    feedPage && hideAddress
      ? (photos?.filter(({ url }) => mediaUrl.safeParse(url).success) ?? null)
      : imagesSchema.parse(
          feedPage ? photos : (photos?.map(protection.image) ?? null),
        );
  if (hideAddress) fields.add("address");
  let status = source.StandardStatus;
  if (feedPage) {
    status = typeof status === "string" ? status.trim().toLowerCase() : null;
    if (status !== null && !standardStatuses.has(status)) status = null;
  }
  const facts: Pick<
    Listing,
    "synthetic" | "status" | "price" | "address" | "bedrooms" | "images"
  > & { withheldFields: WithheldField[] } = {
    synthetic: record.synthetic,
    status,
    price:
      source.ListPrice === null
        ? null
        : { amount: source.ListPrice, currency: "USD" },
    address,
    bedrooms: source.BedroomsTotal,
    images,
    withheldFields: [...fields].sort(),
  };
  for (const field of fields ?? []) {
    facts[field] = null;
  }
  return {
    facts,
    blocks: disclosureSchema.min(1).parse(feedPage ? record.blocks : protection.blocks(record.blocks)),
    pageBlocks: disclosureSchema.parse(feedPage ? record.pageBlocks : protection.blocks(record.pageBlocks)),
    sourceUpdatedAt: record.sourceUpdatedAt,
    ingestedAt: record.ingestedAt,
  };
}
export type NormalizedListing = ReturnType<typeof normalize>;
