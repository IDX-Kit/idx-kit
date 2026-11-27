import type { DisplayBlock, Listing } from "@idx-kit/client";

// Redact fixture disclosure text while the source address is available.
export function addressProtection(address: Listing["address"]) {
  const street = address?.line1.trim();
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = street
    ? new RegExp(
        [
          street.split(/\s+/).map(escape).join("\\s+"),
          escape(encodeURIComponent(street)),
        ].join("|"),
        "gi",
      )
    : null;
  const text = (value: string) =>
    pattern ? value.replace(pattern, "Address withheld") : value;
  const blocks = (values: DisplayBlock[]): DisplayBlock[] =>
    values.map((value) => ({
      id: value.id,
      text: text(value.text),
      placement: value.placement,
      prominence: value.prominence,
      ...(value.image
        ? { image: { url: value.image.url, alt: text(value.image.alt) } }
        : {}),
    }));
  return { blocks };
}
