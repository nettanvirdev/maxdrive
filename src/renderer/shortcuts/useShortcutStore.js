import { create } from "zustand";
import { DEFAULT_BINDINGS } from "./defaults";
import { normaliseChord } from "./keys";
import { COMMAND_MAP } from "@/commands/registry";

const SETTINGS_KEY = "shortcuts";

/**
 * Bindings = defaults with the user's overrides applied.
 *
 * Overrides are stored per command id rather than per chord, so a saved
 * customisation survives a change to the defaults: if a later version moves
 * "Upload files" from Ctrl+U to something else, a user who never customised it
 * gets the new default, and one who did keeps their own.
 *
 * An override of `null` means "unbound".
 */
export const useShortcutStore = create((set, get) => ({
  overrides: {},

  load: async () => {
    try {
      const stored = await window.maxdrive?.settings.get();
      set({ overrides: stored?.[SETTINGS_KEY] || {} });
    } catch {
      /* keep defaults */
    }
  },

  /** Assigns a chord to a command. Pass null to unbind it. */
  setOverride: async (commandId, chord) => {
    const overrides = {
      ...get().overrides,
      [commandId]: chord === null ? null : normaliseChord(chord),
    };
    set({ overrides });
    await window.maxdrive?.settings.set({ [SETTINGS_KEY]: overrides });
  },

  /** Returns a command to its default binding. */
  resetOverride: async (commandId) => {
    const overrides = { ...get().overrides };
    delete overrides[commandId];
    set({ overrides });
    await window.maxdrive?.settings.set({ [SETTINGS_KEY]: overrides });
  },

  resetAll: async () => {
    set({ overrides: {} });
    await window.maxdrive?.settings.set({ [SETTINGS_KEY]: {} });
  },
}));

/**
 * The binding list the dispatcher actually walks, in priority order.
 * Bindings whose command no longer exists are dropped rather than throwing —
 * a stale override from an older version must not break every shortcut.
 */
export function resolveBindings(overrides = {}) {
  return DEFAULT_BINDINGS.filter((binding) => COMMAND_MAP.has(binding.command))
    .map((binding) => {
      if (!Object.prototype.hasOwnProperty.call(overrides, binding.command))
        return binding;
      const chord = overrides[binding.command];
      return chord ? { ...binding, chord: normaliseChord(chord) } : null;
    })
    .filter(Boolean);
}

/**
 * Groups bindings that share a chord.
 *
 * Sharing is not automatically wrong here: Space is meant to be preview-or-
 * pause depending on what is focused. What distinguishes the two cases is
 * whether the commands can ever be available at the same moment - a command
 * with no `when` is always available, so any chord it shares is a genuine
 * clash where one command would simply never fire.
 */
export function findConflicts(bindings) {
  const byChord = new Map();
  for (const binding of bindings) {
    const key = `${binding.chord}::${binding.scope}`;
    if (!byChord.has(key)) byChord.set(key, []);
    byChord.get(key).push(binding);
  }

  const conflicts = [];
  for (const [key, group] of byChord) {
    if (group.length < 2) continue;
    const unconditional = group.filter(
      (binding) => !COMMAND_MAP.get(binding.command)?.when,
    );
    conflicts.push({
      chord: group[0].chord,
      scope: group[0].scope,
      key,
      commands: group.map((binding) => binding.command),
      // Two always-available commands on one chord: the later one is dead.
      hard:
        unconditional.length > 1 ||
        (unconditional.length === 1 && group.length > 1),
    });
  }
  return conflicts;
}

/** True when assigning `chord` to `commandId` would shadow something else. */
export function wouldConflict(bindings, commandId, chord) {
  const normalised = normaliseChord(chord);
  return bindings
    .filter(
      (binding) =>
        binding.command !== commandId && binding.chord === normalised,
    )
    .map((binding) => binding.command);
}
