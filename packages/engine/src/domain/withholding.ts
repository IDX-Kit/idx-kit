import type { DisplayBlock, Listing } from '../../../client/src/generated.ts';

// Apply while the connector still has the source address; never retain it in public facts.
export function addressProtection(address: Listing['address']) {
  const street = address?.line1.trim();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = street ? new RegExp([
    street.split(/\s+/).map(escape).join('\\s+'), escape(encodeURIComponent(street))
  ].join('|'), 'gi') : null;
  const text = (value: string) => pattern ? value.replace(pattern, 'Address withheld') : value;
  const image = (value: NonNullable<Listing['images']>[number]) => {
    // Rewriting an asset URL could lose a required disclosure; reject unsafe references.
    if (text(value.url) !== value.url) throw new Error('Withheld address in media reference');
    return { url: value.url, alt: text(value.alt) };
  };
  const blocks = (values: DisplayBlock[]): DisplayBlock[] => values.map(value => ({
    id: value.id, text: text(value.text), placement: value.placement, prominence: value.prominence,
    ...(value.image ? { image: image(value.image) } : {})
  }));
  return { image, blocks };
}
