import type { DisplayBlock, Listing } from "@idx-kit/client";

// Apply while the connector still has the source address; never retain it in public facts.
export function addressProtection(...addresses: Listing["address"][]) {
  const streets = addresses.flatMap((address) =>
    address?.line1.trim() ? [address.line1.trim()] : [],
  );
  const escape = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = streets.length
    ? new RegExp(
        streets.flatMap((street) => [
          street.split(/\s+/).map(escape).join("\\s+"),
          escape(encodeURIComponent(street)),
        ]).join("|"),
        "gi",
      )
    : null;
  const text = (value: string) =>
    pattern ? value.replace(pattern, "Address withheld") : value;
  const image = (value: NonNullable<Listing["images"]>[number]) => {
    // Rewriting an asset URL could lose a required disclosure; reject unsafe references.
    if (pattern) {
      let components: string[];
      try {
        const url = new URL(value.url, "https://synthetic.example.invalid");
        components = [
          value.url,
          ...[
            value.url,
            url.username,
            url.password,
            url.hostname,
            url.pathname,
            url.search,
            url.hash,
          ].map((component) => decodeURIComponent(component)),
          // Query parsing also decodes form-style plus spaces in both names and values.
          ...Array.from(url.searchParams).flat(),
        ];
      } catch {
        // An undecodable reference cannot be checked safely while the address is withheld.
        throw new Error("Withheld address in media reference");
      }
      if (components.some((component) => text(component) !== component)) {
        throw new Error("Withheld address in media reference");
      }
    }
    return { url: value.url, alt: text(value.alt) };
  };
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
  return { text, image, blocks };
}
