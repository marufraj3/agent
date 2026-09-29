import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ResolveHost = (hostname: string) => Promise<string[]>;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === '::' || normalized === '::1') return true;
  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  return false;
}

export async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export class UnsafePublicUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePublicUrlError';
  }
}

export class PublicUrlService {
  constructor(private readonly resolveHost: ResolveHost = defaultResolveHost) {}

  async validate(value: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new UnsafePublicUrlError('Malformed media URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new UnsafePublicUrlError('Media URL must be a public HTTP(S) URL');
    }
    if (url.port && !['80', '443'].includes(url.port)) {
      throw new UnsafePublicUrlError('Media URL uses a blocked port');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new UnsafePublicUrlError('Private media URLs are not allowed');
    }

    let addresses: string[];
    try {
      addresses = isIP(hostname) ? [hostname] : await this.resolveHost(hostname);
    } catch {
      throw new UnsafePublicUrlError('Media host could not be resolved');
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new UnsafePublicUrlError('Private media URLs are not allowed');
    }
    return url;
  }
}
