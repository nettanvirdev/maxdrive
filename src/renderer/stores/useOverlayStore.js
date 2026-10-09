import { create } from "zustand";

/**
 * Every layer that sits above the page: dialogs, the preview, the command
 * palette, the shortcut cheat sheet.
 *
 * These used to be page-local state, which meant a keystroke had no way to open
 * a rename dialog - only the ⋮ menu could. Hoisting them here is what lets one
 * command be invoked from the keyboard, a menu, the toolbar or the palette.
 *
 * The `stack` exists for Escape. Several components already close themselves on
 * Escape, and with a global handler as well the key would otherwise dismiss two
 * layers at once. Whatever is on top of the stack owns Escape; nothing else
 * reacts to it.
 */
export const useOverlayStore = create((set, get) => ({
  /**
   * { kind: 'rename'|'move'|'share'|'details'|'deleteForever'|'newFolder'|
   *   'pairDevice'|'s3Account'|'sealSetup'|'sealUnlock'|'sealPassword', node }
   * - for s3Account, node is the account row being edited (null = add).
   */
  dialog: null,
  /** The node being previewed, or null. */
  preview: null,
  palette: false,
  shortcutHelp: false,
  /** Ordered list of open layer names - last entry is topmost. */
  stack: [],

  openDialog: (kind, node = null) =>
    set((state) => ({
      dialog: { kind, node },
      stack: push(state.stack, "dialog"),
    })),

  closeDialog: () =>
    set((state) => ({ dialog: null, stack: pull(state.stack, "dialog") })),

  openPreview: (node) =>
    set((state) => ({ preview: node, stack: push(state.stack, "preview") })),

  closePreview: () =>
    set((state) => ({ preview: null, stack: pull(state.stack, "preview") })),

  openPalette: () =>
    set((state) => ({ palette: true, stack: push(state.stack, "palette") })),

  closePalette: () =>
    set((state) => ({ palette: false, stack: pull(state.stack, "palette") })),

  openShortcutHelp: () =>
    set((state) => ({
      shortcutHelp: true,
      stack: push(state.stack, "shortcutHelp"),
    })),

  closeShortcutHelp: () =>
    set((state) => ({
      shortcutHelp: false,
      stack: pull(state.stack, "shortcutHelp"),
    })),

  /** Closes the topmost layer. Returns true if there was one to close. */
  closeTop: () => {
    const { stack } = get();
    const top = stack[stack.length - 1];
    if (!top) return false;
    const close = {
      dialog: get().closeDialog,
      preview: get().closePreview,
      palette: get().closePalette,
      shortcutHelp: get().closeShortcutHelp,
    }[top];
    close?.();
    return true;
  },

  closeAll: () =>
    set({
      dialog: null,
      preview: null,
      palette: false,
      shortcutHelp: false,
      stack: [],
    }),
}));

function push(stack, name) {
  return [...stack.filter((entry) => entry !== name), name];
}

function pull(stack, name) {
  return stack.filter((entry) => entry !== name);
}
