/**
 * Tests for the assertNever exhaustiveness helper.
 * @covers src/utils/assert.ts
 */

import { describe, it, expect } from 'vitest';
import { assertNever } from '../../src/utils/assert';

describe('assertNever', () => {
  it('throws with the default label and the offending value', () => {
    expect(() => assertNever('archived' as never)).toThrow(
      'Unhandled exhaustiveness case: archived',
    );
  });

  it('throws with a custom label', () => {
    expect(() => assertNever('archived' as never, 'Unknown sync scope')).toThrow(
      'Unknown sync scope: archived',
    );
  });

  it('stringifies non-string values', () => {
    expect(() => assertNever(42 as never)).toThrow('Unhandled exhaustiveness case: 42');
    expect(() => assertNever({ k: 1 } as never)).toThrow(
      'Unhandled exhaustiveness case: [object Object]',
    );
  });

  it('has a never return type usable in a typed default branch', () => {
    // Compile-time contract: a fully-handled union narrows to never in the
    // default branch, so assertNever(x) type-checks. A missing case would
    // make x a real type and fail to compile here.
    type Scope = 'a' | 'b';
    const classify = (s: Scope): number => {
      switch (s) {
        case 'a':
          return 1;
        case 'b':
          return 2;
        default:
          return assertNever(s);
      }
    };
    expect(classify('a')).toBe(1);
    expect(classify('b')).toBe(2);
  });
});
