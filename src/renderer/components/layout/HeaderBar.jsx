import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Lock,
  Minus,
  Monitor,
  Moon,
  Search,
  Settings,
  Square,
  Sun,
  Unlock,
  X,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { runCommand } from "@/commands/dispatch";
import { useUiStore } from "@/stores/useUiStore";
import { useSettingsStore } from "@/stores/useSettingsStore";

const THEME_ICON = { light: Sun, dark: Moon, system: Monitor };

/**
 * The 64px header row from design.json doubles as the window titlebar: its
 * background is the drag region, every control inside opts out.
 */
export function HeaderBar() {
  const { windowState, setWindowState, search, history, future } = useUiStore();
  const theme = useSettingsStore((state) => state.theme);
  const seal = useUiStore((state) => state.seal);
  const [draft, setDraft] = useState("");
  const ThemeIcon = THEME_ICON[theme] ?? Monitor;

  useEffect(() => window.electronAPI?.onWindowState?.(setWindowState), [setWindowState]);

  const isMaximized = windowState === "maximized" || windowState === "fullscreen";

  const handleMouseDown = (event) => {
    if (event.target.closest(".titlebar-no-drag")) return;
    if (isMaximized) window.electronAPI?.beginDrag?.();
  };

  const submit = (event) => {
    event.preventDefault();
    search(draft);
  };

  return (
    <header
      className={`col-span-2 flex h-16 select-none items-center gap-4 px-4 ${
        windowState === "normal" ? "titlebar-drag" : ""
      }`}
      onMouseDown={handleMouseDown}
    >
      <div className="flex w-[206px] shrink-0 items-center gap-3">
        <Logo size={32} />
        <span className="text-[22px] font-normal tracking-tight text-foreground">
          MaxDrive
        </span>
      </div>

      <div className="titlebar-no-drag flex shrink-0 items-center gap-1">
        <NavButton onClick={() => runCommand("nav.back")} disabled={!history.length} title="Back">
          <ArrowLeft className="h-5 w-5" />
        </NavButton>
        <NavButton onClick={() => runCommand("nav.forward")} disabled={!future.length} title="Forward">
          <ArrowRight className="h-5 w-5" />
        </NavButton>
      </div>

      <form onSubmit={submit} className="titlebar-no-drag flex max-w-[720px] flex-1">
        <div className="flex h-12 w-full items-center gap-3 rounded-full border border-transparent bg-drive-variant px-4 transition-colors duration-200 ease-standard focus-within:border-[var(--input)] focus-within:bg-[var(--field-focus)]">
          <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
          {/* data-search-input is how the "Search files" command finds this
              box; it is the one control a command reaches through the DOM. */}
          <input
            data-search-input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Escape hands focus back to the page rather than leaving the
              // caret in a box the user has visually left.
              if (event.key === "Escape") {
                setDraft("");
                event.currentTarget.blur();
              }
            }}
            placeholder="Search across all your Drives"
            aria-label="Search across all your Drives"
            className="h-full w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </form>

      {/* App actions and window controls share one 40px centre line so the
          gear and the caption buttons never look off-axis. */}
      <div className="titlebar-no-drag ml-auto flex shrink-0 items-center gap-1">
        {/* Vault mode on: one click locks or unlocks encrypted files. */}
        {seal?.configured && seal.enabled ? (
          <NavButton
            onClick={() => runCommand(seal.unlocked ? "seal.lock" : "seal.unlock")}
            title={
              seal.unlocked
                ? "Encrypted files unlocked - click to lock"
                : "Encrypted files locked - click to unlock"
            }
          >
            {seal.unlocked ? (
              <Unlock className="h-5 w-5" />
            ) : (
              <Lock className="h-5 w-5" />
            )}
          </NavButton>
        ) : null}
        <NavButton onClick={() => runCommand("app.toggleTheme")} title={`Theme: ${theme}`}>
          <ThemeIcon className="h-5 w-5" />
        </NavButton>
        <NavButton onClick={() => runCommand("nav.settings")} title="Settings">
          <Settings className="h-5 w-5" />
        </NavButton>

        <span aria-hidden className="mx-2 h-6 w-px bg-border" />

        <WindowButton onClick={() => window.electronAPI?.minimize()} title="Minimize">
          <Minus className="h-[18px] w-[18px]" />
        </WindowButton>
        <WindowButton onClick={() => window.electronAPI?.maximize()} title={isMaximized ? "Restore" : "Maximize"}>
          {isMaximized ? (
            <Copy className="h-[14px] w-[14px] -scale-x-100" />
          ) : (
            <Square className="h-[13px] w-[13px]" />
          )}
        </WindowButton>
        <WindowButton
          onClick={() => window.electronAPI?.close()}
          title="Close"
          className="hover:bg-destructive hover:text-destructive-foreground"
        >
          <X className="h-[18px] w-[18px]" />
        </WindowButton>
      </div>
    </header>
  );
}

function NavButton({ children, onClick, title, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)] disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** Same 40px box as NavButton, so all header controls sit on one baseline. */
function WindowButton({ children, onClick, title, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)] hover:text-foreground ${className}`}
    >
      {children}
    </button>
  );
}
