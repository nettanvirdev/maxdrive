import { useEffect, useMemo } from "react";
import { chordFromEvent, isTextEntry, isUnsafeWhileTyping } from "./keys";
import { SUPPRESSED_BROWSER_CHORDS } from "./defaults";
import { resolveBindings, useShortcutStore } from "./useShortcutStore";
import { resolveChord, runCommand } from "@/commands/dispatch";
import { buildContext } from "@/commands/context";
import { useOverlayStore } from "@/stores/useOverlayStore";

/**
 * The application's only global key listener.
 *
 * Everything routes through here so shortcuts stay greppable in one place
 * instead of accumulating as ad-hoc listeners in whichever component happened
 * to need one. Mount it once, near the root.
 *
 * Nothing is registered with Electron's `globalShortcut`: these are meant to
 * work while MaxDrive is focused and to stay out of the way of every other
 * application, which a renderer listener gives us for free.
 */
export function KeyboardManager() {
  const overrides = useShortcutStore((state) => state.overrides);
  const load = useShortcutStore((state) => state.load);

  useEffect(() => {
    load();
  }, [load]);

  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);

  useEffect(() => {
    const onKeyDown = (event) => {
      // Let the browser's own composition and repeat handling win.
      if (event.isComposing || event.defaultPrevented) return;

      const chord = chordFromEvent(event);
      if (!chord) return;

      const typing = isTextEntry(event.target);
      const overlayOpen = useOverlayStore.getState().stack.length > 0;
      const ctx = buildContext();

      const binding = resolveChord(bindings, chord, ctx, { overlayOpen });
      if (!binding) {
        // Even unclaimed, suppress the Chromium defaults we never want: a print
        // dialog or a find bar appearing over the app is worse than nothing.
        if (!typing && SUPPRESSED_BROWSER_CHORDS.has(chord)) event.preventDefault();
        return;
      }

      // While typing, only chords that opted in may fire, and never a bare key
      // the field could receive as text. This is what keeps Ctrl+A selecting
      // text in a rename box rather than selecting every file behind it, while
      // still letting Escape back out of that same box.
      if (typing && (!binding.allowInInput || isUnsafeWhileTyping(binding.chord))) return;

      event.preventDefault();
      event.stopPropagation();
      runCommand(binding.command, ctx);
    };

    // Capture phase: the shortcut system decides before a focused row or an
    // overlay's own handler gets a chance, so precedence lives in one place.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [bindings]);

  return null;
}
