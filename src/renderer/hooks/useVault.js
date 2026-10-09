import { useEffect, useState } from "react";
import { useIpcQuery } from "./useIpcQuery";

const api = () => window.maxdrive?.vault;
const NONE = [];

/**
 * Vault status: whether it exists, whether it is open, which accounts host it.
 * Everything the Secure page renders hangs off this - locking anywhere in the
 * app immediately empties the view, because `vaultLockChanged` refetches.
 */
export function useVault() {
  const {
    data: status = null,
    loading,
    reload,
  } = useIpcQuery(() => api()?.status() ?? null, [], [
    "vaultChanged",
    "vaultLockChanged",
  ]);
  return { status, loading, reload };
}

/**
 * Contents of one vault folder. Only ever returns anything while unlocked —
 * the main process refuses the call otherwise, which is what makes a wrong
 * password show nothing rather than an empty-looking vault.
 */
export function useVaultItems(parentId, unlocked) {
  const { data, loading } = useIpcQuery(
    () => (api() && unlocked ? api().list(parentId || null) : null),
    [parentId, unlocked],
    ["vaultChanged"],
  );
  return {
    items: data?.items || NONE,
    crumbs: data?.breadcrumbs || NONE,
    loading,
  };
}

/** Live encrypt/upload/decrypt progress, keyed by item id. */
export function useVaultProgress() {
  const [progress, setProgress] = useState({});

  useEffect(() => {
    const off = window.maxdrive?.on.vaultProgress((event) => {
      setProgress((prev) => {
        if (event.phase === "done") {
          const next = { ...prev };
          delete next[event.itemId];
          return next;
        }
        return {
          ...prev,
          [event.itemId]: { phase: event.phase, pct: event.pct },
        };
      });
    });
    return () => off?.();
  }, []);

  return progress;
}
