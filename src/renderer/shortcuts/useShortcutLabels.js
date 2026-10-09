import { useMemo } from "react";
import { formatChord } from "./keys";
import { resolveBindings, useShortcutStore } from "./useShortcutStore";

/**
 * Command id → display chord, for showing shortcuts anywhere the user might
 * look: the ⋮ menu, tooltips, the palette, settings.
 *
 * Discoverability is most of the value of a shortcut system - a shortcut nobody
 * can find may as well not exist - so this is deliberately cheap to use.
 * When a command has several bindings the first wins, which is why the binding
 * table lists the one worth advertising first.
 */
export function useShortcutLabels() {
  const overrides = useShortcutStore((state) => state.overrides);

  return useMemo(() => {
    const labels = new Map();
    for (const binding of resolveBindings(overrides)) {
      if (!labels.has(binding.command)) {
        labels.set(binding.command, formatChord(binding.chord));
      }
    }
    return labels;
  }, [overrides]);
}
