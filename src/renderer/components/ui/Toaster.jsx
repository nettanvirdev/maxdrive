import { AlertTriangle, Check, Info, X } from "lucide-react";
import { useToastStore } from "@/stores/useToastStore";

const ICONS = { info: Info, success: Check, error: AlertTriangle };

/**
 * Bottom-right, stacked above the transfer tray by the CornerStack in App.jsx —
 * the two never overlap because they share one flex column.
 */
export function Toaster() {
  const { toasts, dismiss } = useToastStore();
  if (!toasts.length) return null;

  return (
    <div className="pointer-events-none flex w-[380px] flex-col items-end gap-2">
      {toasts.map((item) => {
        const Icon = ICONS[item.kind] || Info;
        return (
          <div
            key={item.id}
            className="pointer-events-auto flex w-full animate-fade-in items-center gap-3 rounded-lg border border-border bg-popover py-3 pl-4 pr-2 shadow-gdrop"
          >
            <Icon
              className={`h-4 w-4 shrink-0 ${
                item.kind === "error" ? "text-destructive" : "text-primary"
              }`}
            />
            <span className="min-w-0 flex-1 text-sm text-foreground">{item.message}</span>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--hover-overlay)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
