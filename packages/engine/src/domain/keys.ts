import { createHash } from "node:crypto";

export const scopes = [
  "listings:read",
  "inquiries:write",
  "inquiries:read",
] as const;
export async function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
