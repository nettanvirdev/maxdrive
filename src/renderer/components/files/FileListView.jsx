import { Folder, Link2, MoreVertical } from "lucide-react";
import { AccountAvatar, FileIcon, FileName } from "./FileIcon";
import { describeActivity, formatBytes } from "@/lib/format";
import { useFileRows } from "@/hooks/useFileRows";
import { useSelectionStore } from "@/stores/useSelectionStore";

const COLS =
  "grid-cols-[minmax(0,2.4fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_72px_40px]";

export function FileListView({ files, onOpen, onOpenLocation, onMenu }) {
  const { onKeyDown, rowProps, isSelected } = useFileRows(files);

  return (
    <div
      className="min-w-[760px]"
      role="grid"
      aria-multiselectable="true"
      onKeyDown={onKeyDown}
    >
      {/* Sticky so the column labels survive scrolling the list, which is now
          the only thing that scrolls. */}
      <div
        className={`sticky top-0 z-10 grid ${COLS} items-center gap-4 bg-card px-3 pb-2 pt-1 text-sm font-medium text-muted-foreground`}
      >
        <span>Name</span>
        <span>Activity</span>
        <span>Owner</span>
        <span>Location</span>
        <span className="text-right">Size</span>
        <span />
      </div>

      <div>
        {files.map((file, index) => {
          const selected = isSelected(file);
          return (
            <div
              key={file.id}
              role="row"
              {...rowProps(file, index)}
              onDoubleClick={() => onOpen?.(file)}
              // Right-click opens the same menu as the ⋮ button, at the cursor.
              // It only replaces the selection when the row is outside it, so
              // right-clicking one of several selected items keeps the set.
              onContextMenu={(event) => {
                event.preventDefault();
                if (!selected) useSelectionStore.getState().select(file.id);
                onMenu?.(file, event.clientX, event.clientY);
              }}
              className={`group grid ${COLS} h-12 cursor-default items-center gap-4 border-b border-border px-3 outline-none transition-colors duration-150 ease-standard ${
                selected
                  ? "bg-[var(--selected-overlay)]"
                  : "hover:bg-drive-variant focus-visible:bg-drive-variant"
              }`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <FileIcon mime={file.mime} isFolder={file.is_folder} />
                <FileName file={file} />
                {file.share_link ? (
                  <Link2
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-label="Shared with a link"
                  />
                ) : null}
                <UnavailableBadge status={file.status} />
              </span>

              <span className="truncate text-sm text-muted-foreground">
                {describeActivity(file)}
              </span>

              {/* Owner = the account (Google or S3) physically holding the
                  bytes. Virtual folders live only in the local index, hence
                  "You". */}
              <span className="flex min-w-0 items-center gap-2">
                <AccountAvatar
                  email={file.account_email}
                  photo={file.account_photo}
                  provider={file.account_provider}
                />
                <span className="truncate text-sm text-muted-foreground">
                  {file.account_email ?? "You"}
                </span>
              </span>

              <span className="flex min-w-0 items-center text-sm text-muted-foreground">
                {file.parent_name ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenLocation?.(file);
                    }}
                    title={`Open ${file.parent_name}`}
                    className="flex min-w-0 items-center gap-2 rounded-full px-2 py-1 transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)] hover:text-foreground"
                  >
                    <Folder className="h-4 w-4 shrink-0" />
                    <span className="truncate">{file.parent_name}</span>
                  </button>
                ) : (
                  <span className="px-2">—</span>
                )}
              </span>

              <span className="text-right text-xs text-drive-tertiary">
                {file.is_folder ? "—" : formatBytes(file.size)}
              </span>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  // Same selection rule as right-click: a row outside the
                  // selection becomes it; one inside keeps the whole set.
                  if (!selected) useSelectionStore.getState().select(file.id);
                  // Anchor under the button so the menu lines up with the row.
                  const rect = event.currentTarget.getBoundingClientRect();
                  onMenu?.(file, rect.right, rect.bottom + 4);
                }}
                title="More actions"
                aria-label={`More actions for ${file.name}`}
                className={`flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-opacity duration-150 hover:bg-[var(--hover-overlay)] hover:text-foreground focus:opacity-100 group-hover:opacity-100 ${
                  selected ? "opacity-100" : "opacity-0"
                }`}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Files whose account was disconnected, or that vanished from Drive, still have
 * index rows. Saying so is kinder than letting them look ordinary and fail only
 * when the user tries to open one.
 */
function UnavailableBadge({ status }) {
  if (status !== "orphaned" && status !== "missing_remote") return null;
  const label =
    status === "orphaned" ? "Account disconnected" : "Missing from its storage";
  return (
    <span
      title={label}
      className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
    >
      Unavailable
    </span>
  );
}
