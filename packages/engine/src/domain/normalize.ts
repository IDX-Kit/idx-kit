import type { Listing, DisplayBlock } from "@idx-kit/client";
import { z } from "zod";
import { addressProtection } from "./withholding.ts";

const text = z
  .string()
  .refine((value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
export const sourceKeySchema = text.refine(
  (value) => value.length > 0 && Buffer.byteLength(value) <= 1024,
);
export const timestampSchema = z.iso.datetime().refine(
  (value) => !value.startsWith("0000") && value.length <= 27,
);
const imageSchema = z.object({
  alt: text.refine((value) => value.length > 0),
  url: text.refine((value) => {
    if (/[\s\\]/.test(value) || /%(?![\da-f]{2})/i.test(value)) return false;
    if (value.startsWith("/") && !value.startsWith("//")) return true;
    const url = URL.parse(value);
    return url?.protocol === "https:" && !url.username && !url.password;
  }),
});
const blockSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  text: text.refine((value) => value.length > 0),
  placement: z.enum(["adjacent", "afterListing", "pageFooter"]),
  prominence: z.enum(["normal", "medianListingText", "largestListingText"]),
  image: imageSchema.optional(),
});
const addressSchema = z.object({
  line1: text,
  city: text,
  region: text,
  postalCode: text,
  country: z.string().regex(/^[A-Z]{2}$/),
});

export interface ListingRecord {
  synthetic: boolean;
  withheldFields?: ("status" | "price" | "address" | "bedrooms" | "images")[];
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
    Images: Listing["images"];
    InternetAddressDisplayYN: boolean;
    InternetEntireListingDisplayYN: boolean;
  };
}
export interface FixtureRecord extends ListingRecord {
  feedId: string;
  publicId: string;
  synthetic: true;
}

export function normalize(
  record: ListingRecord,
  previousAddress: Listing["address"] = null,
) {
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
      !/^(0|[1-9][0-9]{0,131071})(\.[0-9]{1,16383})?$/.test(source.ListPrice))
  )
    throw new Error("Invalid price");
  if (source.StandardStatus !== null && !text.safeParse(source.StandardStatus).success)
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
  const fields = z
    .array(z.enum(["status", "price", "address", "bedrooms", "images"]))
    .optional()
    .parse(record.withheldFields);
  const hideAddress =
    !source.InternetAddressDisplayYN || fields?.includes("address");
  const protection = hideAddress
    ? addressProtection(address, previousAddress)
    : addressProtection();
  const facts: Pick<
    Listing,
    | "synthetic"
    | "status"
    | "price"
    | "address"
    | "bedrooms"
    | "images"
    | "withheldFields"
  > = {
    synthetic: record.synthetic,
    status: source.StandardStatus === null ? null : protection.text(source.StandardStatus),
    price:
      source.ListPrice === null
        ? null
        : { amount: source.ListPrice, currency: "USD" },
    address: hideAddress ? null : address,
    bedrooms: source.BedroomsTotal,
    images:
      source.Images === null
        ? null
        : z.array(imageSchema).parse(source.Images.map(protection.image)),
    withheldFields: hideAddress ? ["address"] : [],
  };
  for (const field of fields ?? []) {
    facts[field] = null;
  }
  facts.withheldFields = [
    ...new Set([...facts.withheldFields, ...(fields ?? [])]),
  ];
  return {
    facts,
    blocks: z.array(blockSchema).parse(protection.blocks(record.blocks)),
    pageBlocks: z.array(blockSchema).parse(protection.blocks(record.pageBlocks)),
    sourceUpdatedAt: record.sourceUpdatedAt,
    ingestedAt: record.ingestedAt,
  };
}
export type NormalizedListing = ReturnType<typeof normalize>;
