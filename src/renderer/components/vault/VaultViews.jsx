import { useState } from "react";
import { AlertCircle, Folder, Loader2, MoreVertical } from "lucide-react";
import { FileIcon } from "@/components/files/FileIcon";
import { formatBytes } from "@/lib/format";

/**
 * Vault-specific list and grid views.
 *
 * These deliberately do not reuse FileListView/FileGridView: those are built
 * around indexed Drive nodes (owner, location, sharing, maxthumb) - columns
 * that either don't exist in the vault or would be actively misleading there.
 * What the vault shows instead is where each file is stored and whether it is
 * reachable right now.
 */

const dateOf = (ms) =>
  ms
    ? new Date(ms).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

/**
 * Encrypted thumbnail, served only while the vault is open. `large` fills a
 * grid card's preview area instead of sitting inline in a row.
 */
function VaultThumb({ item, size = "h-10 w-10", large }) {
  const [failed, setFailed] = useState(false);
  if (item.isFolder)
    return (
      <Folder
        className={`${large ? "h-10 w-10" : "h-5 w-5"} shrink-0 text-drive-folder`}
      />
    );
  if (item.hasThumb && !failed) {
    return (
      <img
        src={`maxvault://thumb/${item.id}`}
        alt=""
        onError={() => setFailed(true)}
        className={
          large ? "h-full w-full object-cover" : `${size} shrink-0 rounded object-cover`
        }
      />
    );
  }
  const icon = <FileIcon mime={item.mime} isFolder={false} />;
  return large ? <span className="scale-[2]">{icon}</span> : icon;
}

/** Encrypting / uploading / decrypting, shown inline on the row. */
function PhaseBadge({ progress, item }) {
  if (progress) {
    const label =
      progress.phase === "encrypt"
        ? "Encrypting"
        : progress.phase === "upload"
          ? "Uploading"
          : "Decrypting";
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {label} {progress.pct}%
      </span>
    );
  }
  if (item.state === "failed") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
        <AlertCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  if (!item.isFolder && !item.available) {
    return (
      <span className="shrink-0 text-xs text-drive-docs">
        {item.state === "uploading" ? "Securing…" : "Unavailable"}
      </span>
    );
  }
  return null;
}

const COLS =
  "grid-cols-[minmax(0,3fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_96px_40px]";

export function VaultListView({
  items,
  progress,
  selected,
  onSelect,
  onOpen,
  onMenu,
}) {
  return (
    <div className="min-w-[640px]" role="grid">
      <div
        className={`sticky top-0 z-10 grid ${COLS} items-center gap-4 bg-card px-3 pb-2 pt-1 text-sm font-medium text-muted-foreground`}
      >
        <span>Name</span>
        <span>Added</span>
        <span>Stored on</span>
        <span className="text-right">Size</span>
        <span />
      </div>

      {items.map((item) => {
        const isSelected = selected.has(item.id);
        return (
          <div
            key={item.id}
            role="row"
            tabIndex={0}
            onClick={(event) => onSelect(item, event)}
            onDoubleClick={() => onOpen(item)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!isSelected) onSelect(item, {});
              onMenu(item, event.clientX, event.clientY);
            }}
            className={`group grid ${COLS} h-12 cursor-default items-center gap-4 border-b border-border px-3 outline-none transition-colors duration-150 ease-standard ${
              isSelected
                ? "bg-[var(--selected-overlay)]"
                : "hover:bg-drive-variant focus-visible:bg-drive-variant"
            }`}
          >
            <span className="flex min-w-0 items-center gap-3">
              <VaultThumb item={item} size="h-7 w-7" />
              <span className="truncate text-sm text-foreground">
                {item.name}
              </span>
              <PhaseBadge progress={progress[item.id]} item={item} />
            </span>

            <span className="truncate text-sm text-muted-foreground">
              {dateOf(item.createdAt)}
            </span>

            <span className="truncate text-sm text-muted-foreground">
              {item.isFolder
                ? "—"
                : item.copiesOk === 0
                  ? "Not yet stored"
                  : item.copiesOk === 1
                    ? "1 account"
                    : `${item.copiesOk} accounts`}
            </span>

            <span className="text-right text-sm text-muted-foreground">
              {item.isFolder ? "—" : formatBytes(item.size)}
            </span>

            <button
              type="button"
              aria-label={`Actions for ${item.name}`}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                onMenu(item, rect.right, rect.bottom);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-[var(--hover-overlay)] group-hover:opacity-100 focus-visible:opacity-100"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function VaultGridView({
  items,
  progress,
  selected,
  onSelect,
  onOpen,
  onMenu,
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
      {items.map((item) => {
        const isSelected = selected.has(item.id);
        return (
          <div
            key={item.id}
            role="gridcell"
            tabIndex={0}
            onClick={(event) => onSelect(item, event)}
            onDoubleClick={() => onOpen(item)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!isSelected) onSelect(item, {});
              onMenu(item, event.clientX, event.clientY);
            }}
            className={`group flex cursor-default flex-col overflow-hidden rounded-xl border outline-none transition-colors duration-150 ease-standard ${
              isSelected
                ? "border-primary bg-[var(--selected-overlay)]"
                : "border-border hover:bg-drive-variant focus-visible:bg-drive-variant"
            }`}
          >
            <div className="flex h-28 items-center justify-center bg-drive-variant">
              <VaultThumb item={item} large />
            </div>

            <div className="flex items-center gap-2 px-3 py-2.5">
              <VaultThumb item={{ ...item, hasThumb: false }} size="h-4 w-4" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {item.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {item.isFolder ? "Folder" : formatBytes(item.size)}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Actions for ${item.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onMenu(item, rect.right, rect.bottom);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-[var(--hover-overlay)] group-hover:opacity-100"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </div>

            {progress[item.id] ? (
              <span className="h-0.5 bg-drive-variant">
                <span
                  className="block h-full bg-primary transition-all duration-300 ease-standard"
                  style={{ width: `${progress[item.id].pct}%` }}
                />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
