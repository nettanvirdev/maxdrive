import { useCallback, useEffect, useState } from "react";

/**
 * The data-loading pattern: fetch through window.maxdrive, refetch whenever one
 * of `events` (names under window.maxdrive.on) fires, and again when `deps`
 * change. `data` is undefined until the first load and after a failure, so
 * callers give it a default in the destructure.
 *
 * The "server" is local SQLite behind IPC, so a refetch costs well under a
 * millisecond - invalidating on every change event is cheaper and far simpler
 * than maintaining a cache with surgical updates.
 */
export function useIpcQuery(fetcher, deps, events = []) {
  const [data, setData] = useState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await fetcher());
      setError(null);
    } catch (err) {
      setData(undefined);
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // The caller's deps stand in for the fetcher's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const eventKey = events.join();
  useEffect(() => {
    const on = window.maxdrive?.on;
    const offs = events.map((name) => on?.[name]?.(load));
    return () => offs.forEach((off) => off?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, eventKey]);

  return { data, loading, error, reload: load };
}
