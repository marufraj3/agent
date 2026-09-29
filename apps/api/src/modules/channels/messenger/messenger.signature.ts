import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyMessengerSignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const suppliedHex = signature.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
