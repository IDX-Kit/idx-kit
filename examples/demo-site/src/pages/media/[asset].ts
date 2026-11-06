import type { APIRoute } from "astro";
import first from "../../../assets/synthetic-house-001.svg?raw";
import second from "../../../assets/synthetic-house-002.svg?raw";
import third from "../../../assets/synthetic-house-003.svg?raw";

const images: Record<string, string> = {
  "synthetic-house-001.svg": first,
  "synthetic-house-002.svg": second,
  "synthetic-house-003.svg": third,
};
export const GET: APIRoute = ({ params }) => {
  const image = Object.hasOwn(images, params.asset ?? "")
    ? images[params.asset!]
    : undefined;
  return new Response(image ?? "Image not found", {
    status: image ? 200 : 404,
    headers: {
      "Content-Type": image ? "image/svg+xml" : "text/plain",
      "Cache-Control": "no-store",
    },
  });
};
