import type { DisplayBlock, Listing } from "@idx-kit/client";

// Apply while the connector still has the source address; never retain it in public facts.
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
  const checkReference = (reference: string) => {
    // Rewriting an asset URL could lose a required disclosure; reject unsafe references.
    if (pattern) {
      let components: string[];
      try {
        const url = new URL(reference, "https://synthetic.example.invalid");
        components = [
          reference,
          ...[
            reference,
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
  };
  const image = (value: NonNullable<Listing["images"]>[number]) => {
    checkReference(value.url);
    return { url: value.url, alt: text(value.alt) };
  };
  const blocks = (values: DisplayBlock[]): DisplayBlock[] =>
    values.map((value) => ({
      id: value.id,
      text: text(value.text),
      placement: value.placement,
      prominence: value.prominence,
      ...(value.image ? { image: image(value.image) } : {}),
    }));
  return { checkReference, image, blocks };
}
