import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { COMMANDS, isAvailable } from "@/commands/registry";
import { buildContext } from "@/commands/context";
import { runCommand } from "@/commands/dispatch";
import { useOverlayStore } from "@/stores/useOverlayStore";
import { useShortcutLabels } from "@/shortcuts/useShortcutLabels";

/**
 * Subsequence match: "nf" finds "New folder", "upfo" finds "Upload folder".
 * Scores earlier and more contiguous matches higher so the obvious answer comes
 * first rather than merely appearing somewhere in the list.
 */
export function fuzzyScore(text, query) {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let index = -1;
  let previous = -1;
  for (const char of needle) {
    index = haystack.indexOf(char, index + 1);
    if (index === -1) return -1;
    if (index === previous + 1) score += 3; // adjacent characters
    if (index === 0 || /[\s./-]/.test(haystack[index - 1])) score += 4; // word start
    score -= index * 0.05; // prefer matches nearer the front
    previous = index;
  }
  return score;
}

export function rankCommands(commands, query) {
  if (!query.trim()) return commands;
  return commands
    .map((command) => ({
      command,
      score: Math.max(
        fuzzyScore(command.title, query),
        fuzzyScore(`${command.category} ${command.title}`, query) - 2,
      ),
    }))
    .filter((entry) => entry.score > -1)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command);
}

export function CommandPalette() {
  const open = useOverlayStore((state) => state.palette);
  const close = useOverlayStore((state) => state.closePalette);
  const labels = useShortcutLabels();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  // The context is captured when the palette opens: the selection is still
  // whatever it was, and running a command must act on that rather than on the
  // palette itself.
  const context = useMemo(() => (open ? buildContext() : null), [open]);

  const commands = useMemo(() => {
    if (!context) return [];
    const visible = COMMANDS.filter((command) => command.palette !== false);
    return rankCommands(visible, query).map((command) => ({
      command,
      enabled: isAvailable(command, context),
    }));
  }, [context, query]);

  // Unavailable commands stay listed but disabled - hiding them makes the
  // palette feel unreliable ("it was there a second ago"), and the greyed row
  // tells the user the command exists and why it can't run.
  const firstEnabled = commands.findIndex((entry) => entry.enabled);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  useEffect(() => {
    setActive(firstEnabled === -1 ? 0 : firstEnabled);
  }, [query, firstEnabled]);

  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-index="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const step = (delta) => {
    if (!commands.length) return;
    let next = active;
    for (let i = 0; i < commands.length; i += 1) {
      next = (next + delta + commands.length) % commands.length;
      if (commands[next].enabled) break;
    }
    setActive(next);
  };

  const choose = async (index) => {
    const entry = commands[index];
    if (!entry?.enabled) return;
    close();
    await runCommand(entry.command.id, context);
  };

  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(firstEnabled === -1 ? 0 : firstEnabled);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(commands.length - 1);
    }
    // Escape is handled globally so the whole app closes overlays one way.
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 animate-scrim-in"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="flex max-h-[60vh] w-full max-w-[560px] animate-dialog-in flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-gdrop"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command…"
            aria-label="Search commands"
            aria-activedescendant={`command-${active}`}
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div
          ref={listRef}
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {commands.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No commands match “{query}”.
            </p>
          ) : (
            commands.map(({ command, enabled }, index) => (
              <button
                key={command.id}
                id={`command-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                disabled={!enabled}
                onMouseMove={() => enabled && setActive(index)}
                onClick={() => choose(index)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                  index === active ? "bg-[var(--hover-overlay)]" : ""
                } ${enabled ? "text-foreground" : "cursor-default text-muted-foreground opacity-45"}`}
              >
                <command.icon
                  className={`h-4 w-4 shrink-0 ${
                    command.danger && enabled
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{command.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {command.category}
                </span>
                {labels.get(command.id) ? (
                  <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {labels.get(command.id)}
                  </kbd>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
