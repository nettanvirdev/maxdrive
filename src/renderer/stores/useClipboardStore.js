import { create } from "zustand";

/**
 * The file clipboard for Cut / Copy / Paste.
 *
 * Deliberately separate from the OS clipboard: these are index nodes, not text
 * or files on disk, and writing them into the system clipboard would either
 * lose the account they live on or promise other applications a path that does
 * not exist locally.
 */
export const useClipboardStore = create((set) => ({
  /** The nodes waiting to be pasted. */
  entries: [],
  /** 'cut' moves on paste; 'copy' duplicates. */
  mode: null,

  cut: (entries) => set({ entries, mode: "cut" }),
  copy: (entries) => set({ entries, mode: "copy" }),
  clear: () => set({ entries: [], mode: null }),
}));
