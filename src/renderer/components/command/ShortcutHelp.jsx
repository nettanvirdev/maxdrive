import { useMemo, useState } from "react";
import { Modal, inputClass } from "@/components/ui/Modal";
import { COMMANDS } from "@/commands/registry";
import { useOverlayStore } from "@/stores/useOverlayStore";
import { useShortcutLabels } from "@/shortcuts/useShortcutLabels";

/**
 * The cheat sheet (F1). Lists only commands that actually have a binding —
 * a reference full of blanks is harder to scan than a short complete one.
 */
export function ShortcutHelp() {
  const open = useOverlayStore((state) => state.shortcutHelp);
  const close = useOverlayStore((state) => state.closeShortcutHelp);
  const labels = useShortcutLabels();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byCategory = new Map();
    for (const command of COMMANDS) {
      const chord = labels.get(command.id);
      if (!chord) continue;
      if (
        needle &&
        !command.title.toLowerCase().includes(needle) &&
        !chord.toLowerCase().includes(needle)
      ) {
        continue;
      }
      if (!byCategory.has(command.category)) byCategory.set(command.category, []);
      byCategory.get(command.category).push({ command, chord });
    }
    return [...byCategory.entries()];
  }, [labels, query]);

  if (!open) return null;

  return (
    <Modal title="Keyboard shortcuts" width={620} onClose={close}>
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search shortcuts…"
        aria-label="Search shortcuts"
        className={inputClass}
      />

      {groups.length === 0 ? (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          No shortcuts match “{query}”.
        </p>
      ) : (
        groups.map(([category, entries]) => (
          <section key={category} className="mt-5">
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {category}
            </h3>
            <div className="rounded-lg border border-border">
              {entries.map(({ command, chord }, index) => (
                <div
                  key={command.id}
                  className={`flex items-center justify-between gap-4 px-3 py-2 text-sm ${
                    index ? "border-t border-border" : ""
                  }`}
                >
                  <span className="min-w-0 truncate text-foreground">{command.title}</span>
                  <kbd className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {chord}
                  </kbd>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </Modal>
  );
}
