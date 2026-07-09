import { describe, test, expect } from 'bun:test';
import { mintKey } from '../src/key-mint';

describe('mintKey', () => {
  test('is deterministic for the same pendingId', () => {
    expect(mintKey('p1')).toBe(mintKey('p1'));
  });

  test('differs across pendingIds', () => {
    expect(mintKey('p1')).not.toBe(mintKey('p2'));
  });

  test('returns a well-formed UUIDv5 string', () => {
    const key = mintKey('p1');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
