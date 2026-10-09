import { useCallback, useEffect, useRef } from "react";
import { useSelectionStore } from "@/stores/useSelectionStore";

/**
 * Selection and arrow-key movement for the file views.
 *
 * Arrows live here rather than in the global shortcut registry because they are
 * inherently about the list on screen - how many columns it has, what "down"
 * means - and turning every direction into a command would spread that
 * knowledge across two places. The registry owns actions; this owns traversal.
 *
 * Focus is roving: exactly one row is tabbable, so Tab moves past the list
 * rather than through several thousand rows.
 */
export function useFileRows(files, { columns = 1 } = {}) {
  const ids = useSelectionStore((state) => state.ids);
  const focusId = useSelectionStore((state) => state.focusId);
  const refs = useRef(new Map());

  // Follow the store's focus with real DOM focus, so screen readers and the
  // focus ring agree with what the arrow keys are doing.
  useEffect(() => {
    if (!focusId) return;
    const el = refs.current.get(focusId);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  const onKeyDown = useCallback(
    (event) => {
      const store = useSelectionStore.getState();
      const extend = event.shiftKey;
      const step = {
        ArrowDown: columns,
        ArrowUp: -columns,
        ArrowRight: columns > 1 ? 1 : 0,
        ArrowLeft: columns > 1 ? -1 : 0,
      }[event.key];

      if (step) {
        event.preventDefault();
        store.moveFocus(files, step, extend);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        store.focusEdge(files, "start", extend);
      } else if (event.key === "End") {
        event.preventDefault();
        store.focusEdge(files, "end", extend);
      }
    },
    [files, columns],
  );

  const rowProps = useCallback(
    (file, index) => ({
      ref: (el) => {
        if (el) refs.current.set(file.id, el);
        else refs.current.delete(file.id);
      },
      // Roving tabindex: the focused row, or the first one before any focus.
      tabIndex: file.id === focusId || (!focusId && index === 0) ? 0 : -1,
      "aria-selected": ids.includes(file.id),
      onClick: (event) => {
        const store = useSelectionStore.getState();
        if (event.ctrlKey || event.metaKey) store.toggle(file.id);
        else if (event.shiftKey) store.selectRange(files, file.id);
        else store.select(file.id);
      },
      onFocus: () => {
        // Tabbing or clicking into a row makes it the keyboard's position.
        if (useSelectionStore.getState().focusId !== file.id) {
          useSelectionStore.getState().setFocus(file.id);
        }
      },
    }),
    [files, ids, focusId],
  );

  const isSelected = useCallback((file) => ids.includes(file.id), [ids]);

  return { ids, focusId, onKeyDown, rowProps, isSelected };
}
