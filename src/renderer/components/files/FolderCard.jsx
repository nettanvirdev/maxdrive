import { Folder, MoreVertical } from "lucide-react";
import { formatBytes } from "@/lib/format";

/**
 * design.json folder_card: 48px tall pill-ish card with a trailing overflow
 * button. Two sibling buttons rather than one nested in the other - a button
 * inside a button is invalid markup, and the inner one never fires.
 */
export function FolderCard({ folder, onOpen, onMenu }) {
  return (
    <div
      role="presentation"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu?.(folder, event.clientX, event.clientY);
      }}
      className="group flex h-12 w-full items-center rounded-md bg-drive-folder pr-2 transition-colors duration-150 ease-standard hover:bg-[var(--selected-overlay)]"
    >
      <button
        type="button"
        onClick={() => onOpen?.(folder)}
        onDoubleClick={() => onOpen?.(folder)}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 text-left outline-none"
      >
        <Folder className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={`truncate text-sm ${
              folder.sealLocked ? "italic text-muted-foreground" : "text-foreground"
            }`}
          >
            {folder.name}
          </span>
          {folder.account_email ? (
            <span className="truncate text-xs text-muted-foreground">
              {formatBytes(folder.size)} · {folder.account_email}
            </span>
          ) : null}
        </span>
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu?.(folder, rect.right, rect.bottom + 4);
        }}
        title="More actions"
        aria-label={`More actions for ${folder.name}`}
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-[var(--hover-overlay)] hover:text-foreground focus:opacity-100 group-hover:opacity-100"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
    </div>
  );
}
