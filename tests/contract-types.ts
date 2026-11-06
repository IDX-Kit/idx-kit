import type { Listing } from "@idx-kit/client";
import type { components } from "../.generated/compat.ts";

type CompatibleListing = components["schemas"]["Listing"];
const compatibleToClient = (listing: CompatibleListing): Listing => listing;
const clientToCompatible = (listing: Listing): CompatibleListing => listing;
const nulls: Pick<
  Listing,
  "status" | "price" | "address" | "bedrooms" | "images"
> = {
  status: null,
  price: null,
  address: null,
  bedrooms: null,
  images: null,
};
// @ts-expect-error A defined fact must be present even when its value is unknown.
const missingPrice: Pick<Listing, "price"> = {};
const numericAmount: NonNullable<Listing["price"]> = {
  // @ts-expect-error Decimal money is a string on the wire.
  amount: 100,
  currency: "USD",
};
void [
  compatibleToClient,
  clientToCompatible,
  nulls,
  missingPrice,
  numericAmount,
];
