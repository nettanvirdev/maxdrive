/**
 * Chord parsing, matching and display.
 *
 * A chord is stored in one canonical form - `"mod+shift+n"` - where `mod` is
 * the platform's primary accelerator: Ctrl on Windows and Linux, Command on
 * macOS. Storing `mod` rather than the resolved key means a saved custom
 * shortcut stays correct if the same index is opened on another platform, and
 * it keeps every comparison a plain string equality.
 */

const MODIFIER_ORDER = ["mod", "ctrl", "alt", "shift"];

export const isMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "");

/** Keys whose `event.key` we normalise so chords read the way users say them. */
const KEY_ALIASES = {
  esc: "escape",
  del: "delete",
  return: "enter",
  " ": "space",
  spacebar: "space",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  plus: "+",
};

/** How each key is written in the UI. */
const KEY_LABELS = {
  escape: "Esc",
  delete: "Delete",
  backspace: "Backspace",
  enter: "Enter",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
  tab: "Tab",
  comma: ",",
};

const MOD_LABELS = isMac
  ? { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
  : { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };

function normaliseKey(key) {
  const lower = String(key).toLowerCase();
  return KEY_ALIASES[lower] || lower;
}

/**
 * Canonicalises a chord so `"Shift+Mod+N"` and `"mod+shift+n"` are the same
 * string. Without this, conflict detection would miss duplicates written in a
 * different order.
 */
export function normaliseChord(chord) {
  if (!chord) return "";
  const parts = String(chord)
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  // A trailing literal "+" (as in "mod++") survives the filter as an empty
  // segment, so recover it from the raw string rather than losing the key.
  const key = parts.length ? normaliseKey(parts[parts.length - 1]) : "";
  const mods = new Set(parts.slice(0, -1));
  const ordered = MODIFIER_ORDER.filter((mod) => mods.has(mod));
  return [...ordered, key].join("+");
}

/** Builds the canonical chord for a real keyboard event. */
export function chordFromEvent(event) {
  const key = normaliseKey(event.key);

  // Modifier presses on their own are not chords.
  if (["control", "shift", "alt", "meta", "os"].includes(key)) return "";

  const mods = [];
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const secondary = isMac ? event.ctrlKey : false;

  if (primary) mods.push("mod");
  if (secondary) mods.push("ctrl");
  if (event.altKey) mods.push("alt");
  if (event.shiftKey) mods.push("shift");

  const ordered = MODIFIER_ORDER.filter((mod) => mods.includes(mod));
  return [...ordered, key].join("+");
}

/** Human-readable form, e.g. "Ctrl + Shift + N" (or "⌘⇧N" on macOS). */
export function formatChord(chord) {
  const normalised = normaliseChord(chord);
  if (!normalised) return "";
  const parts = normalised.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((mod) => MOD_LABELS[mod] || mod);
  const label =
    KEY_LABELS[key] || (key.length === 1 ? key.toUpperCase() : titleCase(key));
  return isMac ? [...mods, label].join("") : [...mods, label].join(" + ");
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** True when the chord uses no modifier. */
export function isBareKey(chord) {
  const normalised = normaliseChord(chord);
  return Boolean(normalised) && !normalised.includes("+");
}

/**
 * Bare keys a text field can never receive as input, so a global shortcut may
 * still claim them mid-typing.
 *
 * Escape belongs here or it stops working exactly where it is needed most: the
 * caret sits in the palette's search box or a rename field, and those are the
 * moments the user most wants to back out.
 */
const SAFE_WHILE_TYPING = new Set([
  "escape",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/**
 * Whether a chord must stand down because the user is typing. Modified chords
 * decide via their own `allowInInput` flag; bare printable keys are always
 * unsafe, since claiming "r" or Space would make text entry impossible.
 */
export function isUnsafeWhileTyping(chord) {
  const normalised = normaliseChord(chord);
  if (!isBareKey(normalised)) return false;
  return !SAFE_WHILE_TYPING.has(normalised);
}

/**
 * Whether the event landed in something the user is typing into. Global
 * shortcuts must stand aside for these or Ctrl+A stops selecting text and
 * starts selecting files - the single most jarring thing a shortcut system can
 * get wrong.
 */
export function isTextEntry(target) {
  if (!target || typeof target.closest !== "function") return false;
  if (target.isContentEditable) return true;
  const el = target.closest(
    "input, textarea, select, [contenteditable='true']",
  );
  if (!el) return false;
  if (el.tagName === "INPUT") {
    // Checkboxes and buttons are not text entry, so Space/Enter still work.
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ![
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "range",
    ].includes(type);
  }
  return true;
}
