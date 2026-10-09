import { normaliseChord } from "./keys";

/**
 * Default key bindings.
 *
 * Order matters. Several chords are deliberately claimed by more than one
 * command - Space previews a file in the file list and pauses a job in the
 * transfer list - and the dispatcher walks this list in order, running the
 * first binding whose command is available in the current context. That is what
 * makes shortcuts context-aware without a separate keymap per screen.
 *
 * `scope`:
 *   'page'   - suppressed while a dialog, preview or the palette is open, so
 *              Enter submits a form instead of opening a file behind it.
 *   'always' - survives overlays (Escape, the palette, search).
 *
 * `allowInInput` lets a chord through while the user is typing. Only safe for
 * chords no text field claims: never Ctrl+A/C/V/X, never a bare key.
 */
export const DEFAULT_BINDINGS = [
  /* Always available, including over an overlay or inside a text field. */
  {
    command: "app.closeOverlay",
    chord: "escape",
    scope: "always",
    allowInInput: true,
  },
  {
    command: "palette.open",
    chord: "mod+p",
    scope: "always",
    allowInInput: true,
  },
  {
    command: "search.focus",
    chord: "mod+k",
    scope: "always",
    allowInInput: true,
  },
  {
    command: "search.focus",
    chord: "mod+f",
    scope: "always",
    allowInInput: true,
  },
  {
    command: "app.shortcutHelp",
    chord: "f1",
    scope: "always",
    allowInInput: true,
  },
  {
    command: "app.shortcutHelp",
    chord: "mod+/",
    scope: "always",
    allowInInput: true,
  },

  /* Navigation. */
  { command: "nav.back", chord: "alt+left", scope: "page" },
  { command: "nav.forward", chord: "alt+right", scope: "page" },
  { command: "nav.parent", chord: "alt+up", scope: "page" },
  { command: "nav.root", chord: "mod+home", scope: "page" },
  { command: "nav.home", chord: "mod+shift+h", scope: "page" },
  { command: "nav.transfers", chord: "mod+j", scope: "page" },
  { command: "nav.settings", chord: "mod+,", scope: "page" },

  /* Creating things. */
  { command: "file.upload", chord: "mod+u", scope: "page" },
  { command: "file.uploadFolder", chord: "mod+shift+u", scope: "page" },
  { command: "file.newFolder", chord: "mod+shift+n", scope: "page" },

  /* Background jobs claim these first - both are gated on a focused job, so
     they fall through to the file commands below on every other screen. */
  { command: "job.toggle", chord: "space", scope: "page" },
  { command: "job.retry", chord: "r", scope: "page" },
  { command: "job.retryAll", chord: "mod+r", scope: "page" },
  { command: "job.remove", chord: "delete", scope: "page" },

  /* Files. */
  { command: "file.rename", chord: "f2", scope: "page" },
  { command: "file.trash", chord: "delete", scope: "page" },
  { command: "file.deleteForever", chord: "shift+delete", scope: "page" },
  { command: "file.open", chord: "enter", scope: "page" },
  { command: "file.preview", chord: "space", scope: "page" },
  { command: "file.preview", chord: "mod+shift+p", scope: "page" },
  { command: "file.openExternal", chord: "mod+enter", scope: "page" },
  { command: "file.selectAll", chord: "mod+a", scope: "page" },
  { command: "file.cut", chord: "mod+x", scope: "page" },
  { command: "file.copy", chord: "mod+c", scope: "page" },
  { command: "file.paste", chord: "mod+v", scope: "page" },
  { command: "file.duplicate", chord: "mod+d", scope: "page" },

  /* Application. */
  { command: "app.toggleViewMode", chord: "mod+shift+v", scope: "page" },
].map((binding) => ({ ...binding, chord: normaliseChord(binding.chord) }));

/**
 * Chords the browser would otherwise act on. Electron gives us Chromium's
 * defaults whether we want them or not, so any chord we claim here must have
 * its default suppressed - Ctrl+P would open a print dialog over the app and
 * Ctrl+F would open Chromium's own find bar.
 */
export const SUPPRESSED_BROWSER_CHORDS = new Set(
  ["mod+p", "mod+f", "mod+d", "mod+u", "mod+j", "mod+r", "mod+g", "f1"].map(
    normaliseChord,
  ),
);
