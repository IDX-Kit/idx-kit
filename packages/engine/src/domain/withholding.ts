import type { DisplayBlock, Listing } from "@idx-kit/client";

export const genericPhotoAlt = "Property photo";
const plain = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{Nd}]/gu, "");

export function addressProtection(...addresses: Listing["address"][]) {
  const streets = [...new Set(addresses.map((address) => plain(address?.line1 ?? "")).filter(Boolean))];
  const containsStreet = (value: string) => {
    if (!streets.length) return;
    const matches = (value: string) => {
      const folded = plain(value);
      return streets.some((street) => folded.includes(street));
    };
    if (matches(value)) return true;
    try {
      return matches(decodeURIComponent(value));
    } catch {
      // An undecodable reference cannot be checked for a street.
      return;
    }
  };
  const text = (value: string) =>
    containsStreet(value) ? "Address withheld" : value;
  const image = (value: NonNullable<Listing["images"]>[number]) => {
    if (streets.length && containsStreet(value.url) !== false)
      throw new Error("Withheld address in media reference");
    return { url: value.url, alt: text(value.alt) };
  };
  const photos = (values: Listing["images"], hideAddress: boolean) =>
    values?.flatMap((value) => {
      const unsafe = containsStreet(value.url);
      if (unsafe || (hideAddress && unsafe === undefined)) return [];
      return [{
        url: value.url,
        alt: containsStreet(value.alt) === false ? value.alt : genericPhotoAlt,
      }];
    }) ?? null;
  const blocks = (values: DisplayBlock[]): DisplayBlock[] =>
    values.map((value) => {
      if (containsStreet(value.id))
        throw new Error("Withheld address in disclosure ID");
      return {
        id: value.id,
        text: text(value.text),
        placement: value.placement,
        prominence: value.prominence,
        ...(value.image ? { image: image(value.image) } : {}),
      };
    });
  return { text, image, blocks, photos };
}
