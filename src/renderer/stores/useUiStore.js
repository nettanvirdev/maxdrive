import { create } from "zustand";

/**
 * View + navigation state. There is no router: the app has a handful of views
 * and no URLs worth deep-linking, so a history stack here is simpler and gives
 * us Drive-style back/forward for free.
 */
export const useUiStore = create((set, get) => ({
  view: "home", // home | browse | search | transfers | storage | backup | secure | settings
  folderId: null,
  query: "",
  viewMode: "list", // list | grid
  windowState: "normal",
  history: [],
  future: [],
  // Mirrors the main process's vault session so commands and shortcuts can ask
  // cheaply. It is a hint for the UI only - every real check happens in main.
  vaultUnlocked: false,
  // Vault mode ("seal") status mirrored the same way: { configured, enabled,
  // unlocked, retryAfterMs, autolockMinutes } or null before the first read.
  seal: null,

  setWindowState: (windowState) => set({ windowState }),
  setViewMode: (viewMode) => set({ viewMode }),
  setVaultUnlocked: (vaultUnlocked) => set({ vaultUnlocked }),
  refreshSeal: () =>
    window.maxdrive?.seal
      ?.status()
      .then((seal) => set({ seal }))
      .catch(() => {}),

  navigate: (next) =>
    set((state) => ({
      ...next,
      history: [
        ...state.history,
        { view: state.view, folderId: state.folderId, query: state.query },
      ],
      future: [],
    })),

  openFolder: (folderId) => get().navigate({ view: "browse", folderId }),

  search: (query) =>
    query.trim()
      ? get().navigate({ view: "search", query })
      : set({ query: "" }),

  back: () =>
    set((state) => {
      const previous = state.history[state.history.length - 1];
      if (!previous) return state;
      return {
        ...previous,
        history: state.history.slice(0, -1),
        future: [
          { view: state.view, folderId: state.folderId, query: state.query },
          ...state.future,
        ],
      };
    }),

  forward: () =>
    set((state) => {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return {
        ...next,
        history: [
          ...state.history,
          { view: state.view, folderId: state.folderId, query: state.query },
        ],
        future: rest,
      };
    }),
}));
