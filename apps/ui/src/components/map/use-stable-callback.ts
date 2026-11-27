import * as React from 'react';

/** A callback with a fixed identity that always calls the latest `fn`; undefined while `fn` is undefined. */
export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  const ref = React.useRef(fn);
  React.useLayoutEffect(() => {
    ref.current = fn;
  });
  const defined = fn !== undefined;
  return React.useMemo(() => (defined ? (...args: A) => ref.current!(...args) : undefined), [defined]);
}
