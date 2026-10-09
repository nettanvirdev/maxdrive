import { useEffect, useRef, useState } from "react";
import { MoreVertical } from "lucide-react";
import { AccountAvatar, FileIcon, FileName } from "./FileIcon";
import { fileType } from "@/lib/mime";
import { formatBytes } from "@/lib/format";
import { useFileRows } from "@/hooks/useFileRows";
import { useSelectionStore } from "@/stores/useSelectionStore";

/**
 * How many cards fit on a row right now. Arrow Down has to move by exactly one
 * visual row, and the grid is `auto-fill`, so the count changes with the window
 * and can only be read back from the resolved layout.
 */
function useGridColumns(ref) {
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const template = getComputedStyle(el).gridTemplateColumns;
      setColumns(Math.max(1, template.split(" ").filter(Boolean).length));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return columns;
}

/**
 * design.json file_grid_card: 220px card = 40px header + 136px preview + 44px footer.
 * The preview area shows a cached thumbnail once Phase 7 lands; until then it
 * falls back to a large tinted type icon rather than an empty box.
 */
export function FileGridView({ files, onOpen, onMenu }) {
  const gridRef = useRef(null);
  const columns = useGridColumns(gridRef);
  const { onKeyDown, rowProps, isSelected } = useFileRows(files, { columns });

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-multiselectable="true"
      onKeyDown={onKeyDown}
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4"
    >
      {files.map((file, index) => {
        const selected = isSelected(file);
        const { icon: Icon, color } = fileType(file.mime, file.is_folder);
        return (
          <div
            key={file.id}
            role="gridcell"
            {...rowProps(file, index)}
            onDoubleClick={() => onOpen?.(file)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!selected) useSelectionStore.getState().select(file.id);
              onMenu?.(file, event.clientX, event.clientY);
            }}
            className={`group flex h-[220px] flex-col overflow-hidden rounded-md border bg-drive-file outline-none transition-shadow duration-200 ease-standard hover:shadow-gcard ${
              selected
                ? "border-primary bg-[var(--selected-overlay)]"
                : "border-drive-cardborder"
            }`}
          >
            <div className="flex h-10 shrink-0 items-center gap-2 px-3">
              <FileIcon mime={file.mime} isFolder={file.is_folder} className="h-4 w-4" />
              <FileName file={file} />
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  // Same selection rule as right-click: a card outside the
                  // selection becomes it; one inside keeps the whole set.
                  if (!selected) useSelectionStore.getState().select(file.id);
                  const rect = event.currentTarget.getBoundingClientRect();
                  onMenu?.(file, rect.right, rect.bottom + 4);
                }}
                title="More actions"
                aria-label={`More actions for ${file.name}`}
                className={`ml-auto flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-opacity duration-150 hover:bg-[var(--hover-overlay)] hover:text-foreground group-hover:opacity-100 ${
                  selected ? "opacity-100" : "opacity-0"
                }`}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </div>

            <div className="mx-2 flex h-[136px] shrink-0 items-center justify-center overflow-hidden rounded-sm bg-card">
              {/* No thumbnail for vault-mode files: Drive only holds ciphertext. */}
              {!file.is_folder &&
              !file.sealed &&
              file.drive_file_id &&
              file.account_provider !== "s3" ? (
                // Served by the maxthumb:// protocol from the main process,
                // which owns the auth header Google requires for thumbnails.
                // S3 has no thumbnail service, so those keep the type icon.
                <Thumb file={file} fallback={<Icon className="h-12 w-12 opacity-40" style={{ color }} />} />
              ) : (
                <Icon className="h-12 w-12 opacity-40" style={{ color }} />
              )}
            </div>

            <div className="flex h-11 shrink-0 items-center gap-2 px-3">
              <AccountAvatar
                email={file.account_email}
                photo={file.account_photo}
                provider={file.account_provider}
              />
              <span className="truncate text-xs text-muted-foreground">
                {file.account_email ?? "You"}
              </span>
              {file.size ? (
                <span className="ml-auto shrink-0 text-xs text-drive-tertiary">
                  {formatBytes(file.size)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Thumbnail with a graceful fallback to the mime icon on 404/failure. */
function Thumb({ file, fallback }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      src={`maxthumb://node/${encodeURIComponent(file.id)}`}
      alt=""
      className="h-full w-full object-cover"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
