/**
 * Compile-time exhaustiveness assertion.
 *
 * Call in a `switch` / `if` default branch where every case is handled: the
 * argument narrows to `never`, so a later union extension that misses a case
 * fails to compile at the call site. Throws at runtime as a defensive net for
 * the (statically unreachable) bypass.
 *
 * For branches that must NOT throw — a fail-closed UI fallback, a defensive
 * migration skip — use `x satisfies never` plus the fallback instead (§6.3).
 *
 * @handbook 6.3-exhaustive-switch
 * @tested tests/utils/assert.test.ts
 */
export function assertNever(value: never, label = 'Unhandled exhaustiveness case'): never {
  throw new Error(`${label}: ${String(value)}`);
}
