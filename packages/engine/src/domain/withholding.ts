import type { DisplayBlock, Listing } from "@idx-kit/client";

// Apply while the connector still has the source address; never retain it in public facts.
export function addressProtection(...addresses: Listing["address"][]) {
  const streets = [...new Set(addresses.flatMap((address) =>
    address?.line1.trim() ? [address.line1.trim()] : [],
  ))];
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = streets.length
    ? new RegExp(
        streets
          .flatMap((street) => [
            street.split(/\s+/).map(escape).join("\\s+"),
            escape(encodeURIComponent(street)),
          ])
          .join("|"),
        "gi",
      )
    : null;
  const text = (value: string) =>
    pattern ? value.replace(pattern, "Address withheld") : value;
  const referencePattern = streets.length
    ? new RegExp(
        streets.map((street) => street.split(/\s+/).map(escape).join("[\\s_+-]+")).join("|"),
        "i",
      )
    : null;
  const referenceContainsStreet = (reference: string) => {
    if (!referencePattern) return;
    try {
      const url = new URL(reference, "https://synthetic.example.invalid");
      const parts = [
        reference,
        ...[reference, url.username, url.password, url.hostname, url.pathname, url.search, url.hash]
          .map((part) => decodeURIComponent(part)),
        ...Array.from(url.searchParams).flat(),
      ];
      return parts.some((part) => referencePattern.test(part) || text(part) !== part);
    } catch {
      // An undecodable reference cannot be checked for a street.
      return;
    }
  };
  const image = (value: NonNullable<Listing["images"]>[number]) => {
    if (pattern && referenceContainsStreet(value.url) !== false)
      throw new Error("Withheld address in media reference");
    return { url: value.url, alt: text(value.alt) };
  };
  const photos = (values: Listing["images"], hideAddress: boolean) =>
    values?.flatMap((value) => {
      const containsStreet = referenceContainsStreet(value.url);
      if (containsStreet || (hideAddress && containsStreet === undefined)) return [];
      return [{
        url: value.url,
        alt: pattern && text(value.alt) === value.alt ? value.alt : "Property photo",
      }];
    }) ?? null;
  const blocks = (values: DisplayBlock[]): DisplayBlock[] =>
    values.map((value) => {
      if (text(value.id) !== value.id)
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
