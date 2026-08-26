/**
 * UUID versie 5 (RFC 4122): een naam-gebaseerde, deterministische UUID.
 *
 * Bewust niet `randomUUID()`: de collection-URL van een dataset moet tussen
 * runs hetzelfde blijven. Wie de link deelt of in een viewer bewaart, moet hem
 * morgen nog kunnen openen — ook al is de steekproef erin dan ververst.
 */
import { createHash } from 'node:crypto';

/** De standaard-namespace voor URL's uit RFC 4122, appendix C. */
const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

export function uuidv5(name: string, namespace: string = NAMESPACE_URL): string {
  const bytes = createHash('sha1')
    .update(Buffer.concat([parseUuid(namespace), Buffer.from(name, 'utf8')]))
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // versie 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122-variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

function parseUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Ongeldige UUID: ${uuid}`);
  return Buffer.from(hex, 'hex');
}
