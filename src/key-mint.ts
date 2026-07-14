import { createHash } from 'node:crypto';

const KEY_MINT_NAMESPACE = '6f6a1f2e-6b7a-4b8e-9a9a-2f8e4b6a1c3d';

function namespaceBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function mintKey(pendingId: string): string {
  const hash = createHash('sha256')
    .update(namespaceBytes(KEY_MINT_NAMESPACE))
    .update(Buffer.from(pendingId, 'utf-8'))
    .digest()
    .subarray(0, 16);

  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
