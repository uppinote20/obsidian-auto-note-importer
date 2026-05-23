/**
 * @covers src/utils/debounce.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from '../../src/utils/debounce';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('debounce', () => {
  it('invokes the wrapped fn once after the trailing delay', () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d();
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid calls within the delay window', () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d(); d(); d(); d();
    vi.advanceTimersByTime(50);
    d(); d();
    vi.advanceTimersByTime(99);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('uses the args from the latest invocation', () => {
    const spy = vi.fn();
    const d = debounce(spy, 50);
    d('a');
    d('b');
    d('c');
    vi.advanceTimersByTime(50);
    expect(spy).toHaveBeenCalledWith('c');
  });

  it('schedules a new run after a previous one already fired', () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d();
    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(1);
    d();
    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns a function with the same arity-shape (forwards every arg)', () => {
    const spy = vi.fn();
    const d = debounce(spy, 10);
    d(1, 'two', { three: true });
    vi.advanceTimersByTime(10);
    expect(spy).toHaveBeenCalledWith(1, 'two', { three: true });
  });
});
