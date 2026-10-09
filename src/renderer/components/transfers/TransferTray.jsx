import { AlertTriangle, Check, ChevronDown, Upload, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { TransferRow } from "@/components/transfers/TransferRow";
import { isActive, useTransfersStore } from "@/stores/useTransfersStore";
import { formatEta, formatSpeed } from "@/lib/format";

/**
 * Drive's bottom-right transfer panel.
 *
 * Fixed to the viewport rather than sticky in the scroll container - sticky
 * lands mid-screen whenever the page is shorter than the window, which is
 * exactly what it did before.
 */
export function TransferTray() {
  const {
    transfers,
    trayOpen,
    trayDismissed,
    speeds,
    setTrayOpen,
    dismissTray,
    clearCompleted,
  } = useTransfersStore();

  if (transfers.length === 0 || trayDismissed) return null;

  const active = transfers.filter(isActive);
  const failed = transfers.filter((t) => t.state === "failed");
  const done = transfers.filter((t) => t.state === "done");

  // One bar for the whole batch: bytes finished over bytes committed.
  const totalBytes = transfers.reduce((sum, t) => sum + (t.size || 0), 0);
  const doneBytes = transfers.reduce(
    (sum, t) => sum + (t.state === "done" ? t.size || 0 : t.bytes_done || 0),
    0,
  );
  const percent = totalBytes
    ? Math.min(100, (doneBytes / totalBytes) * 100)
    : 0;
  const combinedBps = active.reduce(
    (sum, t) => sum + (speeds[t.id]?.bps || 0),
    0,
  );
  const eta = formatEta(totalBytes - doneBytes, combinedBps);

  const title = active.length
    ? `${verbFor(active)} ${active.length} item${active.length === 1 ? "" : "s"}`
    : failed.length
      ? `${failed.length} transfer${failed.length === 1 ? "" : "s"} failed`
      : "Transfers complete";

  const subtitle = active.length
    ? [`${Math.round(percent)}%`, formatSpeed(combinedBps), eta]
        .filter(Boolean)
        .join(" · ")
    : failed.length
      ? `${done.length} finished, ${failed.length} failed`
      : `${done.length} item${done.length === 1 ? "" : "s"} finished`;

  const close = () => {
    if (!active.length) clearCompleted();
    dismissTray();
  };

  return (
    // Position comes from the CornerStack in App.jsx, which owns the corner and
    // keeps the toasts stacked above this rather than on top of it.
    <div className="pointer-events-none">
      <div className="pointer-events-auto w-[380px] overflow-hidden rounded-xl border border-border bg-popover shadow-gdrop">
        <div className="relative flex items-center gap-3 px-4 py-3">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              failed.length && !active.length
                ? "bg-destructive/10 text-destructive"
                : active.length
                  ? "bg-primary/10 text-primary"
                  : "bg-drive-sheets/10 text-drive-sheets"
            }`}
          >
            {active.length ? (
              <Upload className="h-4 w-4" />
            ) : failed.length ? (
              <AlertTriangle className="h-4 w-4" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </span>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {title}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          </span>

          <IconButton
            size="md"
            label={trayOpen ? "Collapse" : "Expand"}
            onClick={() => setTrayOpen(!trayOpen)}
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform duration-200 ease-standard ${
                trayOpen ? "" : "rotate-180"
              }`}
            />
          </IconButton>
          <IconButton size="md" icon={X} label="Close" onClick={close} />

          {active.length ? (
            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-drive-variant">
              <span
                className="block h-full bg-primary transition-[width] duration-300 ease-standard"
                style={{ width: `${percent}%` }}
              />
            </span>
          ) : null}
        </div>

        {trayOpen ? (
          <div className="max-h-[320px] divide-y divide-border overflow-y-auto border-t border-border">
            {transfers.slice(0, 25).map((transfer) => (
              <TransferRow
                key={transfer.id}
                transfer={transfer}
                bps={speeds[transfer.id]?.bps}
                compact
              />
            ))}
            {transfers.length > 25 ? (
              <p className="px-4 py-2 text-xs text-muted-foreground">
                and {transfers.length - 25} more…
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** "Uploading" / "Downloading" / "Moving" - or "Transferring" for a mixed batch. */
function verbFor(active) {
  const kinds = new Set(active.map((t) => t.kind));
  if (kinds.size > 1) return "Transferring";
  const [kind] = kinds;
  return (
    { upload: "Uploading", download: "Downloading", migrate: "Moving" }[kind] ||
    "Transferring"
  );
}
