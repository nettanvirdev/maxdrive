import { create } from "zustand";

/**
 * Smoothing factor for the per-transfer speed estimate. Chunked uploads arrive
 * in bursts - an unsmoothed rate swings between 0 and 40 MB/s and is unreadable.
 */
const SPEED_ALPHA = 0.35;
const MIN_SAMPLE_MS = 400;

export const useTransfersStore = create((set, get) => ({
  transfers: [],
  trayOpen: true,
  trayDismissed: false,
  // id -> { bytes, at, bps } - derived, never persisted.
  speeds: {},
  /** The job the keyboard is on, so Space/R/Delete know what they act on. */
  focusId: null,

  setTrayOpen: (trayOpen) => set({ trayOpen }),
  dismissTray: () => set({ trayDismissed: true }),
  setFocus: (focusId) => set({ focusId }),

  refresh: async () => {
    try {
      const transfers = (await window.maxdrive?.transfers.list()) ?? [];
      set((state) => ({
        transfers,
        // A new batch of work re-opens the tray the user closed earlier.
        trayDismissed: transfers.some(isActive) ? false : state.trayDismissed,
      }));
    } catch {
      set({ transfers: [] });
    }
  },

  /** Progress arrives coalesced (<=4/s) as an array, so patch in place. */
  applyProgress: (updates) =>
    set((state) => {
      if (!updates?.length) return state;
      const byId = new Map(updates.map((u) => [u.id, u]));
      const now = Date.now();
      const speeds = { ...state.speeds };

      for (const update of updates) {
        const previous = speeds[update.id];
        const elapsed = previous ? now - previous.at : 0;
        if (previous && elapsed >= MIN_SAMPLE_MS) {
          const instant =
            ((update.bytes_done - previous.bytes) / elapsed) * 1000;
          speeds[update.id] = {
            bytes: update.bytes_done,
            at: now,
            bps:
              previous.bps == null
                ? Math.max(0, instant)
                : previous.bps * (1 - SPEED_ALPHA) +
                  Math.max(0, instant) * SPEED_ALPHA,
          };
        } else if (!previous) {
          speeds[update.id] = { bytes: update.bytes_done, at: now, bps: null };
        }
      }

      return {
        speeds,
        transfers: state.transfers.map((t) =>
          byId.has(t.id) ? { ...t, ...byId.get(t.id) } : t,
        ),
      };
    }),

  pause: (id) => window.maxdrive?.transfers.pause(id).then(get().refresh),
  resume: (id) => window.maxdrive?.transfers.resume(id).then(get().refresh),
  cancel: (id) => window.maxdrive?.transfers.cancel(id).then(get().refresh),
  retry: (id) => window.maxdrive?.transfers.retry(id).then(get().refresh),
  remove: (id) =>
    window.maxdrive?.transfers.remove(id).then(() => {
      if (get().focusId === id) set({ focusId: null });
      return get().refresh();
    }),
  clearCompleted: () =>
    window.maxdrive?.transfers.clearCompleted().then(get().refresh),
}));

const ACTIVE_STATES = ["queued", "allocating", "running", "paused"];

export function isActive(transfer) {
  return ACTIVE_STATES.includes(transfer.state);
}
