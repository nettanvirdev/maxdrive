import { useCallback, useEffect, useState } from "react";
import { ChevronRight, File, Folder, History, Trash2 } from "lucide-react";
import { Modal, ModalButton, ModalError } from "@/components/ui/Modal";
import { toast } from "@/stores/useToastStore";
import { formatBytes } from "@/lib/format";

const api = () => window.maxdrive;

/**
 * Browse a set's cloud backup and restore a selection to its original place.
 * Everything renders from local bookkeeping (backup entries / the archive
 * manifest) - opening this costs zero Drive calls.
 */
export function RestoreBrowser({ set, onClose }) {
  const [prefix, setPrefix] = useState("");
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [overwrite, setOverwrite] = useState(false);
  const [includeTrashed, setIncludeTrashed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(
    (nextPrefix) => {
      api()
        .localBackup.tree(set.id, nextPrefix)
        .then(setRows)
        .catch((err) => setError(err.message));
    },
    [set.id],
  );

  useEffect(() => {
    load(prefix);
  }, [load, prefix]);

  const toggle = (relPath) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const restore = () => {
    setBusy(true);
    setError(null);
    api()
      .localBackup.restore({
        setId: set.id,
        // Nothing ticked = restore the folder currently being viewed.
        paths: selected.size ? [...selected] : prefix ? [prefix] : null,
        overwrite,
        includeTrashed,
      })
      .then((result) => {
        if (result.restored != null) {
          // Archive mode extracts synchronously.
          toast.success(
            `Restored ${result.restored} file(s)` +
              (result.skipped ? `, ${result.skipped} already present.` : "."),
          );
        } else if (result.queued) {
          toast.success(
            `Restoring ${result.queued} file(s)` +
              (result.untrashed
                ? ` (${result.untrashed} recovered from trash)`
                : "") +
              (result.skipped ? `; ${result.skipped} already present.` : "."),
          );
        } else {
          toast.info(
            result.skipped
              ? `Nothing to do - ${result.skipped} file(s) are already present.`
              : "Nothing to restore.",
          );
        }
        onClose();
      })
      .catch((err) => {
        setError(err.message);
        setBusy(false);
      });
  };

  const crumbs = prefix ? prefix.split("/") : [];

  return (
    <Modal
      title={`Restore from “${set.name}”`}
      icon={<History className="h-5 w-5 text-primary" />}
      subtitle={`Back to ${set.local_root}`}
      width={640}
      onClose={onClose}
      footer={
        <>
          <div className="mr-auto flex items-center gap-4 text-xs text-muted-foreground">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              Overwrite existing files
            </label>
            {set.mode !== "archive" ? (
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={includeTrashed}
                  onChange={(e) => setIncludeTrashed(e.target.checked)}
                />
                Recover trashed copies
              </label>
            ) : null}
          </div>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" busy={busy} onClick={restore}>
            {selected.size
              ? `Restore ${selected.size} selected`
              : prefix
                ? "Restore this folder"
                : "Restore everything missing"}
          </ModalButton>
        </>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setPrefix("")}
          className="rounded px-1.5 py-0.5 hover:bg-[var(--hover-overlay)] hover:text-foreground"
        >
          {set.name}
        </button>
        {crumbs.map((part, index) => (
          <span key={index} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3" />
            <button
              type="button"
              onClick={() => setPrefix(crumbs.slice(0, index + 1).join("/"))}
              className="rounded px-1.5 py-0.5 hover:bg-[var(--hover-overlay)] hover:text-foreground"
            >
              {part}
            </button>
          </span>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {prefix
              ? "This folder is empty."
              : "Nothing has been backed up yet."}
          </p>
        ) : (
          <div className="max-h-[340px] divide-y divide-border overflow-y-auto">
            {rows.map((row) => (
              <div
                key={row.relPath}
                className="flex h-10 items-center gap-3 px-3 text-sm hover:bg-[var(--hover-overlay)]"
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${row.name}`}
                  checked={selected.has(row.relPath)}
                  onChange={() => toggle(row.relPath)}
                />
                {row.isFolder ? (
                  <button
                    type="button"
                    onClick={() => setPrefix(row.relPath)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-primary" />
                    <span className="truncate text-foreground">{row.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {row.files} files · {formatBytes(row.size)}
                    </span>
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-foreground">{row.name}</span>
                    <span className="ml-1 flex shrink-0 items-center gap-1.5">
                      {row.state === "trashed" ? (
                        <span className="flex items-center gap-1 rounded-full bg-drive-variant px-2 py-0.5 text-[10px] text-muted-foreground">
                          <Trash2 className="h-3 w-3" /> in Drive trash
                        </span>
                      ) : null}
                      {row.missingLocally && row.state !== "trashed" ? (
                        <span className="rounded-full bg-drive-variant px-2 py-0.5 text-[10px] text-muted-foreground">
                          missing locally
                        </span>
                      ) : null}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {formatBytes(row.size)}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Files that already exist locally are skipped unless “Overwrite” is on.
        {set.mode === "archive"
          ? " Archive restores download the whole backup before extracting."
          : ""}
      </p>

      <ModalError>{error}</ModalError>
    </Modal>
  );
}
