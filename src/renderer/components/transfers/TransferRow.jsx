import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  Download,
  FolderOpen,
  Pause,
  Play,
  RotateCw,
  Upload,
  X,
} from "lucide-react";
import { FileIcon } from "@/components/files/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { isActive, useTransfersStore } from "@/stores/useTransfersStore";
import { mimeFromName } from "@/lib/mime";
import { formatBytes, formatEta, formatSpeed } from "@/lib/format";

export const KIND_ICON = {
  upload: Upload,
  download: Download,
  migrate: ArrowRightLeft,
};

const join = (...parts) => parts.filter(Boolean).join(" · ");
const store = () => useTransfersStore.getState();

/**
 * One transfer. `compact` is the bottom-right tray (file icon with a status
 * badge, actions on hover); the default is the Transfers page row, which is
 * focusable so Space, R and Delete have something to act on.
 */
export function TransferRow({ transfer, bps, compact }) {
  const running = isActive(transfer);
  const failed = transfer.state === "failed";
  const percent = transfer.size
    ? Math.min(100, (transfer.bytes_done / transfer.size) * 100)
    : 0;
  const KindIcon = KIND_ICON[transfer.kind] || Upload;
  const focusId = useTransfersStore((state) => state.focusId);
  const setFocus = useTransfersStore((state) => state.setFocus);

  const progress = `${formatBytes(transfer.bytes_done)} of ${formatBytes(transfer.size)}`;
  const detail = failed
    ? transfer.error_message || "Failed"
    : !compact
      ? join(
          progress,
          formatSpeed(bps),
          formatEta((transfer.size || 0) - (transfer.bytes_done || 0), bps),
          transfer.account_email,
        )
      : transfer.state === "done"
        ? join(formatBytes(transfer.size), transfer.account_email)
        : transfer.state === "queued"
          ? "Waiting…"
          : transfer.state === "paused"
            ? `Paused · ${progress}`
            : join(progress, formatSpeed(bps), transfer.account_email);

  const size = compact ? "sm" : "md";
  const actions = (
    <>
      {transfer.kind === "download" &&
      transfer.state === "done" &&
      transfer.local_path ? (
        <IconButton
          size={size}
          icon={FolderOpen}
          label="Show in folder"
          onClick={() => window.maxdrive.shell.showInFolder(transfer.local_path)}
        />
      ) : null}
      {transfer.state === "running" ? (
        <IconButton
          size={size}
          icon={Pause}
          label="Pause"
          onClick={() => store().pause(transfer.id)}
        />
      ) : null}
      {transfer.state === "paused" ? (
        <IconButton
          size={size}
          icon={Play}
          label="Resume"
          onClick={() => store().resume(transfer.id)}
        />
      ) : null}
      {failed ? (
        <IconButton
          size={size}
          icon={RotateCw}
          label="Retry"
          onClick={() => store().retry(transfer.id)}
        />
      ) : null}
      {running ? (
        <IconButton
          size={size}
          icon={X}
          label="Cancel"
          onClick={() => store().cancel(transfer.id)}
        />
      ) : null}
    </>
  );

  const bar = (
    <span
      className={`${compact ? "mt-1.5" : "mt-2"} block h-1 w-full overflow-hidden rounded-full bg-drive-variant`}
    >
      <span
        className="block h-full rounded-full bg-primary transition-[width] duration-300 ease-standard"
        style={{ width: `${percent}%` }}
      />
    </span>
  );

  if (compact) {
    return (
      <div className="group flex items-center gap-3 px-4 py-2.5">
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
          <FileIcon
            mime={mimeFromName(transfer.name)}
            isFolder={false}
            className="h-5 w-5"
          />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-popover">
            {transfer.state === "done" ? (
              <Check className="h-3 w-3 text-drive-sheets" />
            ) : failed ? (
              <AlertTriangle className="h-3 w-3 text-destructive" />
            ) : (
              <KindIcon className="h-3 w-3 text-muted-foreground" />
            )}
          </span>
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">
            {transfer.name}
          </span>
          <span
            className={`block truncate text-xs ${
              failed ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {detail}
          </span>
          {running && transfer.state !== "queued" ? bar : null}
        </span>

        <span className="flex shrink-0 items-center gap-1">
          {transfer.state === "running" ? (
            <span className="w-9 text-right text-xs tabular-nums text-muted-foreground group-hover:hidden">
              {Math.round(percent)}%
            </span>
          ) : null}
          <span
            className={
              transfer.state === "running" ? "hidden group-hover:flex" : "flex"
            }
          >
            {actions}
          </span>
        </span>
      </div>
    );
  }

  const focused = focusId === transfer.id;
  return (
    <div
      tabIndex={0}
      aria-current={focused}
      onFocus={() => setFocus(transfer.id)}
      onClick={() => setFocus(transfer.id)}
      className={`flex items-center gap-3 p-4 outline-none ${
        focused
          ? "bg-[var(--selected-overlay)]"
          : "focus-visible:bg-drive-variant"
      }`}
    >
      <KindIcon className="h-5 w-5 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{transfer.name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        {running ? bar : null}
      </div>

      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">
        {running ? `${Math.round(percent)}%` : transfer.state}
      </span>

      <div className="flex shrink-0 gap-1">{actions}</div>
    </div>
  );
}
