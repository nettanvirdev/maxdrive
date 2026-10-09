import { useCallback, useState } from "react";

/**
 * Starts the OAuth flow and tracks its state.
 *
 * Shared rather than duplicated because the "Connect an account" affordance
 * appears on three screens, and every one of them needs the same busy state —
 * consent opens in the system browser, so without it the button looks dead.
 */
export function useConnectAccount() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      return await window.maxdrive.accounts.connect();
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { connect, busy, error };
}
