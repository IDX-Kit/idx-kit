export const scopes = ['listings:read', 'inquiries:write', 'inquiries:read'] as const;
export async function hashSecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
