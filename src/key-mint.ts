import { v5 as uuidv5 } from 'uuid';

const KEY_MINT_NAMESPACE = '6f6a1f2e-6b7a-4b8e-9a9a-2f8e4b6a1c3d';

export function mintKey(pendingId: string): string {
  return uuidv5(pendingId, KEY_MINT_NAMESPACE);
}
