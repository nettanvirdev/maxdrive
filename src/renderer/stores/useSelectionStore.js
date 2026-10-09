import { create } from "zustand";

/**
 * File selection, lifted out of FilesPage so a keystroke, a menu and the command
 * palette all act on the same thing.
 *
 * Three pieces of state, matching how desktop file managers behave:
 *   ids     - everything currently selected
 *   anchor  - where a Shift-range started
 *   focus   - the item the caret is on, which is not always the selection
 *             (Ctrl+Arrow moves focus without changing what is selected)
 *
 * The visible list is passed in per call rather than stored. It changes on every
 * navigation and re-sort, and a stale copy here would silently select the wrong
 * rows.
 */
export const useSelectionStore = create((set, get) => ({
  ids: [],
  anchorId: null,
  focusId: null,
  /**
   * What the active page is currently showing. Published by the page so that
   * commands fired from the keyboard or the palette - which have no access to
   * React state - can resolve "the selection" without the page handing it over.
   */
  list: [],

  setList: (list) => {
    if (get().list === list) return;
    set({ list });
    get().prune(list);
  },

  /** Plain click: replaces the selection. */
  select: (id) => set({ ids: id ? [id] : [], anchorId: id, focusId: id }),

  /** Ctrl+click: adds or removes one item without disturbing the rest. */
  toggle: (id) =>
    set((state) => {
      const has = state.ids.includes(id);
      return {
        ids: has
          ? state.ids.filter((value) => value !== id)
          : [...state.ids, id],
        anchorId: id,
        focusId: id,
      };
    }),

  /** Shift+click: everything between the anchor and here. */
  selectRange: (list, id) =>
    set((state) => {
      const ids = list.map((item) => item.id);
      const from = ids.indexOf(state.anchorId ?? id);
      const to = ids.indexOf(id);
      if (from === -1 || to === -1)
        return { ids: [id], anchorId: id, focusId: id };
      const [start, end] = from <= to ? [from, to] : [to, from];
      return {
        ids: ids.slice(start, end + 1),
        anchorId: state.anchorId ?? id,
        focusId: id,
      };
    }),

  selectAll: (list) =>
    set({
      ids: list.map((item) => item.id),
      anchorId: list[0]?.id ?? null,
      focusId: list[list.length - 1]?.id ?? null,
    }),

  clear: () => set({ ids: [], anchorId: null, focusId: null }),

  setFocus: (focusId) => set({ focusId }),

  /**
   * Arrow-key movement. `extend` grows the selection from the anchor, matching
   * Shift+Arrow in Explorer; otherwise focus and selection move together.
   */
  moveFocus: (list, delta, extend = false) => {
    if (!list.length) return;
    const state = get();
    const ids = list.map((item) => item.id);
    const current = ids.indexOf(state.focusId);
    // No focus yet: the first Down lands on the first row, Up on the last.
    const next =
      current === -1
        ? delta > 0
          ? 0
          : ids.length - 1
        : Math.min(ids.length - 1, Math.max(0, current + delta));
    const id = ids[next];
    if (extend) get().selectRange(list, id);
    else get().select(id);
  },

  focusEdge: (list, edge, extend = false) => {
    if (!list.length) return;
    const id = edge === "start" ? list[0].id : list[list.length - 1].id;
    if (extend) get().selectRange(list, id);
    else get().select(id);
  },

  /** Drops ids that are no longer on screen, e.g. after a delete or a filter. */
  prune: (list) =>
    set((state) => {
      const ids = new Set(list.map((item) => item.id));
      const kept = state.ids.filter((id) => ids.has(id));
      if (
        kept.length === state.ids.length &&
        (!state.focusId || ids.has(state.focusId))
      ) {
        return state; // Nothing changed - avoid a pointless re-render.
      }
      return {
        ids: kept,
        anchorId: ids.has(state.anchorId) ? state.anchorId : null,
        focusId: ids.has(state.focusId) ? state.focusId : null,
      };
    }),
}));

/** Resolves the selected ids against a list, preserving the list's order. */
export function selectedNodes(list, ids) {
  if (!ids.length) return [];
  const wanted = new Set(ids);
  return list.filter((item) => wanted.has(item.id));
}
