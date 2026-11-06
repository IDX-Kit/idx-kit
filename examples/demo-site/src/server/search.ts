import type { SearchListingsQuery } from "@idx-kit/client";

export const fields = [
  "city",
  "minPrice",
  "maxPrice",
  "minBedrooms",
  "sort",
] as const;
export type Field = (typeof fields)[number];

export function searchForm(params: URLSearchParams) {
  const values = Object.fromEntries(
    fields.map((field) => [field, params.get(field) ?? ""]),
  ) as Record<Field, string>;
  const errors: Partial<Record<Field, string>> = {};
  const query: SearchListingsQuery = {};
  for (const field of fields) {
    if (params.getAll(field).length > 1)
      errors[field] = "Enter one value for this field.";
  }
  if (values.city.trim()) query.city = values.city;
  for (const field of ["minPrice", "maxPrice"] as const) {
    if (!values[field]) continue;
    if (!/^(0|[1-9][0-9]*)$/.test(values[field]))
      errors[field] = "Enter a whole US dollar amount, using digits only.";
    else query[field] = `${values[field]}.00`;
  }
  if (values.minBedrooms) {
    if (
      !/^[0-9]+$/.test(values.minBedrooms) ||
      Number(values.minBedrooms) > 100
    ) {
      errors.minBedrooms = "Enter a whole bedroom count from 0 to 100.";
    } else query.minBedrooms = Number(values.minBedrooms);
  }
  if (values.sort === "price" || values.sort === "-price")
    query.sort = values.sort;
  else if (values.sort) errors.sort = "Choose a price order.";
  if (params.has("after")) query.after = params.get("after")!;
  const first = new URLSearchParams();
  for (const field of fields) {
    if (values[field]) first.set(field, values[field]);
  }
  const href = (after?: string) => {
    const next = new URLSearchParams(first);
    if (after) next.set("after", after);
    return "/search" + (next.size ? `?${next}` : "");
  };
  return { values, errors, query, href };
}
