import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { COMMANDS, COMMAND_MAP } from "@/commands/registry";
import { chordFromEvent, formatChord } from "@/shortcuts/keys";
import {
  findConflicts,
  resolveBindings,
  useShortcutStore,
  wouldConflict,
} from "@/shortcuts/useShortcutStore";
import { inputClass } from "@/components/ui/Modal";

/**
 * The shortcut editor. Every command with a default binding is listed; clicking
 * a chord starts recording and the next key press becomes the new binding.
 *
 * Conflicts are shown rather than silently prevented, because a shared chord is
 * often correct here - Space is deliberately preview-or-pause. What matters is
 * that the user can see the sharing and judge it.
 */
export function ShortcutSettings() {
  const { overrides, load, setOverride, resetOverride, resetAll } =
    useShortcutStore();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState(null);

  useEffect(() => {
    load();
  }, [load]);

  const bindings = useMemo(() => resolveBindings(overrides), [overrides]);
  const conflicts = useMemo(() => findConflicts(bindings), [bindings]);

  const conflictedCommands = useMemo(() => {
    const set = new Set();
    for (const conflict of conflicts) {
      if (conflict.hard) conflict.commands.forEach((id) => set.add(id));
    }
    return set;
  }, [conflicts]);

  // One row per command that has a binding, using the first one listed.
  const rows = useMemo(() => {
    const seen = new Map();
    for (const binding of bindings) {
      if (!seen.has(binding.command)) seen.set(binding.command, binding.chord);
    }
    const needle = query.trim().toLowerCase();
    return COMMANDS.filter((command) => seen.has(command.id))
      .map((command) => ({
        command,
        chord: seen.get(command.id),
        customised: Object.prototype.hasOwnProperty.call(overrides, command.id),
      }))
      .filter(
        ({ command, chord }) =>
          !needle ||
          command.title.toLowerCase().includes(needle) ||
          command.category.toLowerCase().includes(needle) ||
          formatChord(chord).toLowerCase().includes(needle),
      );
  }, [bindings, overrides, query]);

  // While recording, this listener owns the keyboard - the global manager is
  // capture-phase, so recording must also capture or the chord being assigned
  // would fire its own command instead of being captured.
  useEffect(() => {
    if (!recording) return undefined;

    const onKeyDown = (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return; // A lone modifier - keep waiting for the real key.

      setOverride(recording, chord);
      setRecording(null);
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [recording, setOverride]);

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-base font-medium text-foreground">
          Keyboard shortcuts
        </h2>
        <button
          type="button"
          onClick={resetAll}
          className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-[var(--hover-overlay)] hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset all
        </button>
      </div>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search shortcuts…"
        aria-label="Search shortcuts"
        className={`${inputClass} mb-3`}
      />

      <div className="overflow-hidden rounded-xl border border-border">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No shortcuts match “{query}”.
          </p>
        ) : (
          rows.map(({ command, chord, customised }, index) => {
            const clash = conflictedCommands.has(command.id);
            const shared = wouldConflict(bindings, command.id, chord);
            return (
              <div
                key={command.id}
                className={`flex items-center gap-3 px-4 py-2.5 ${
                  index ? "border-t border-border" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {command.title}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {command.category}
                    {shared.length ? (
                      <> · also used by {shared.map(titleOf).join(", ")}</>
                    ) : null}
                  </span>
                </span>

                {clash ? (
                  <AlertTriangle
                    className="h-4 w-4 shrink-0 text-destructive"
                    aria-label="Conflicting shortcut"
                  />
                ) : null}

                <button
                  type="button"
                  onClick={() => setRecording(command.id)}
                  aria-label={`Change shortcut for ${command.title}`}
                  className={`min-w-[104px] shrink-0 rounded-lg border px-2 py-1 text-xs transition-colors ${
                    recording === command.id
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground hover:bg-[var(--hover-overlay)]"
                  }`}
                >
                  {recording === command.id
                    ? "Press a key…"
                    : formatChord(chord)}
                </button>

                <button
                  type="button"
                  onClick={() => resetOverride(command.id)}
                  disabled={!customised}
                  title="Reset to default"
                  aria-label={`Reset shortcut for ${command.title}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--hover-overlay)] hover:text-foreground disabled:opacity-30"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Shortcuts work only while MaxDrive is focused. Some chords are shared on
        purpose - Space previews a file in the file list and pauses a job in the
        transfer list.
      </p>
    </section>
  );
}

function titleOf(commandId) {
  return COMMAND_MAP.get(commandId)?.title || commandId;
}
