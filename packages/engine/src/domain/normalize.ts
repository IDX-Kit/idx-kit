import type { Listing, DisplayBlock } from "@idx-kit/client";
import { addressProtection } from "./withholding.ts";

export interface FixtureRecord {
  feedId: string;
  publicId: string;
  synthetic: true;
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
export function normalize(record: FixtureRecord) {
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
  if (typeof source.ListingKey !== "string" || !source.ListingKey.length)
    throw new Error("Invalid source key");
  if (
    record.synthetic !== true ||
    !/^lst_[A-Za-z0-9_-]+$/.test(record.publicId)
  )
    throw new Error("Invalid fixture identity");
  if (
    source.ListPrice !== null &&
    (typeof source.ListPrice !== "string" ||
      !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(source.ListPrice))
  )
    throw new Error("Invalid price");
  if (
    source.StandardStatus !== null &&
    typeof source.StandardStatus !== "string"
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
  if (source.Images !== null && !Array.isArray(source.Images))
    throw new Error("Invalid images");
  if (
    source.Address !== null &&
    (typeof source.Address !== "object" ||
      !["line1", "city", "region", "postalCode", "country"].every(
        (key) =>
          typeof (source.Address as Record<string, unknown>)[key] === "string",
      ) ||
      !/^[A-Z]{2}$/.test(source.Address.country))
  )
    throw new Error("Invalid address");
  if (
    source.Images?.some(
      (image) =>
        !image ||
        typeof image.url !== "string" ||
        typeof image.alt !== "string" ||
        !image.alt.length,
    )
  )
    throw new Error("Invalid image");
  const hideAddress =
    !source.InternetAddressDisplayYN ||
    record.withheldFields?.includes("address");
  const protection = addressProtection(hideAddress ? source.Address : null);
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
    synthetic: true,
    status: source.StandardStatus,
    price:
      source.ListPrice === null
        ? null
        : { amount: source.ListPrice, currency: "USD" },
    address: hideAddress ? null : source.Address,
    bedrooms: source.BedroomsTotal,
    images: source.Images?.map(protection.image) ?? null,
    withheldFields: hideAddress ? ["address"] : [],
  };
  for (const field of record.withheldFields ?? []) {
    if (!["status", "price", "address", "bedrooms", "images"].includes(field))
      throw new Error("Invalid withheld field");
    facts[field] = null;
  }
  facts.withheldFields = [
    ...new Set([...facts.withheldFields, ...(record.withheldFields ?? [])]),
  ];
  return {
    feedId: record.feedId,
    sourceKey: source.ListingKey,
    publicId: record.publicId,
    facts,
    entireListingDisplay: source.InternetEntireListingDisplayYN,
    blocks: protection.blocks(record.blocks),
    pageBlocks: protection.blocks(record.pageBlocks),
    sourceUpdatedAt: record.sourceUpdatedAt,
    ingestedAt: record.ingestedAt,
  };
}
export type NormalizedListing = ReturnType<typeof normalize>;
