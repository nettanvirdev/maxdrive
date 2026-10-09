import { create } from "zustand";
import {
  DEFAULT_SCHEME,
  applyScheme,
  applyTheme,
  readStoredScheme,
  readStoredTheme,
  storeScheme,
  storeTheme,
} from "@/lib/theme";

const DEFAULTS = {
  theme: "system", // light | dark | system
  colorScheme: DEFAULT_SCHEME, // graphite | drive | midnight
  viewMode: "list", // list | grid
  minimizeToTray: true,
  openAtLogin: false,
  autoResumeTransfers: true,
  headroomMb: 200,
  s3RescanMinutes: 15, // 0 = only on manual Re-index
};

const media = window.matchMedia("(prefers-color-scheme: dark)");

/** Applies and mirrors whichever appearance keys `values` carries. */
function applyAppearance(values) {
  if (values.theme) {
    applyTheme(values.theme);
    storeTheme(values.theme);
  }
  if (values.colorScheme) {
    applyScheme(values.colorScheme);
    storeScheme(values.colorScheme);
  }
}

export const useSettingsStore = create((set, get) => ({
  ...DEFAULTS,
  theme: readStoredTheme(),
  colorScheme: readStoredScheme(),

  load: async () => {
    let stored = {};
    try {
      stored = (await window.maxdrive?.settings.get()) ?? {};
    } catch {
      /* first run, or main process not ready - defaults are fine */
    }
    const next = {
      ...DEFAULTS,
      theme: readStoredTheme(),
      colorScheme: readStoredScheme(),
      ...stored,
    };
    applyAppearance(next);
    set(next);
  },

  update: async (patch) => {
    set(patch);
    applyAppearance(patch);
    try {
      await window.maxdrive?.settings.set(patch);
    } catch {
      /* keep the optimistic value; it re-syncs on next load */
    }
  },

  cycleTheme: () => {
    const order = ["light", "dark", "system"];
    const next = order[(order.indexOf(get().theme) + 1) % order.length];
    get().update({ theme: next });
  },
}));

// Follow the OS while the app is open, but only in "system" mode.
media.addEventListener("change", () => {
  if (useSettingsStore.getState().theme === "system") applyTheme("system");
});
