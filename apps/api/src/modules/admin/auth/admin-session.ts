import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'alzeena_admin_session';
function signature(payload: string, secret: string) { return createHmac('sha256', secret).update(`admin-session:${payload}`).digest('base64url'); }
export function createAdminSession(secret: string, ttlHours: number) {
  const payload = `${Date.now() + ttlHours * 3_600_000}.${randomBytes(16).toString('base64url')}`;
  return `${payload}.${signature(payload, secret)}`;
}
export function verifyAdminSession(value: string | undefined, secret: string): boolean {
  if (!value) return false; const parts = value.split('.'); if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`; const expected = signature(payload, secret); const received = parts[2]!;
  if (expected.length !== received.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) return false;
  const expiresAt = Number(parts[0]); return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
export function parseCookies(header: string | undefined): Record<string,string> {
  return Object.fromEntries((header ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2) as Array<[string,string]>);
}
export function adminCookie(value: string, secure: boolean, maxAgeSeconds: number) {
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
