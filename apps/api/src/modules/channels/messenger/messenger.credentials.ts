import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key(secret: string) { return createHash('sha256').update(secret).digest(); }
export function encryptMessengerToken(token: string, secret: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
export function decryptMessengerToken(value: string, secret: string): string {
  const [version, iv, tag, encrypted] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted Messenger credential');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}
export function maskMessengerToken(token?: string) {
  if (!token) return null;
  return `${token.slice(0, 4)}${'*'.repeat(Math.min(16, Math.max(8, token.length - 8)))}${token.slice(-2)}`;
}
