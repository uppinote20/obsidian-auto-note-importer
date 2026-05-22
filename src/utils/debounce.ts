/**
 * Trailing-edge debounce helper for input handlers that would otherwise
 * trigger heavy work (disk writes, provider reconfigure) on every keystroke.
 *
 * @handbook 5.1-ui-components
 * @tested tests/utils/debounce.test.ts
 */

/**
 * Returns a function that, when invoked, schedules `fn` to run after `delay`
 * milliseconds of inactivity. Repeated calls reset the timer; only the last
 * invocation's arguments survive to the call site.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number,
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
}
