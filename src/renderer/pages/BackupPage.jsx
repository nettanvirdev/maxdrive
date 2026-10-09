import { useEffect, useState } from "react";
import {
  Archive,
  DatabaseBackup,
  FolderOpen,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  AlertTriangle,
  Lock,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { IconButton } from "@/components/ui/IconButton";
import { EmptyState } from "@/components/files/EmptyState";
import { Modal, ModalButton } from "@/components/ui/Modal";
import {
  BackupSetDialog,
  describeSchedule,
} from "@/components/backup/BackupSetDialog";
import { RestoreBrowser } from "@/components/backup/RestoreBrowser";
import { useIpcQuery } from "@/hooks/useIpcQuery";
import { toast } from "@/stores/useToastStore";
import { formatBytes, formatRelative } from "@/lib/format";

const api = () => window.maxdrive;
const NONE = [];
const IDLE = { globalPaused: false, activeRuns: [] };

/**
 * The Backup tab: local folders mirrored one-way into a hidden area of the
 * connected Drives. Cards per set, live run progress, and the restore browser.
 */
export function BackupPage({ accounts = [], hasAccounts }) {
  const { data: sets = NONE, reload: reloadSets } = useIpcQuery(
    () => api()?.localBackup.listSets(),
    [],
    ["localBackupChanged"],
  );
  const { data: status = IDLE, reload: reloadStatus } = useIpcQuery(
    () => api()?.localBackup.status(),
    [],
    // Turning vault mode on or off pauses or resumes every backup.
    ["localBackupChanged", "sealChanged"],
  );
  const [progress, setProgress] = useState({}); // setId -> run progress
  const [editing, setEditing] = useState(null); // null | "new" | set
  const [restoring, setRestoring] = useState(null); // set
  const [deleting, setDeleting] = useState(null); // set

  const refresh = () => {
    reloadSets();
    reloadStatus();
  };

  useEffect(
    () =>
      api()?.on.localBackupProgress((p) =>
        setProgress((prev) => ({ ...prev, [p.setId]: p })),
      ),
    [],
  );

  const run = (set) =>
    api()
      .localBackup.runNow(set.id)
      .then(() => toast.info(`Backing up “${set.name}”…`))
      .catch((err) => toast.error(err.message));

  const togglePaused = (set) =>
    (set.paused
      ? api().localBackup.resumeSet(set.id)
      : api().localBackup.pauseSet(set.id)
    ).catch((err) => toast.error(err.message));

  const confirmDeletions = (set) =>
    api()
      .localBackup.confirmDeletions(set.id)
      .then(() => toast.info("Re-running with deletions confirmed."))
      .catch((err) => toast.error(err.message));

  if (!hasAccounts) {
    return (
      <PageShell title="Backup">
        <EmptyState
          icon={DatabaseBackup}
          title="Connect a Google Drive account first"
          description="Backups are stored in your Google Drive accounts (S3 storage can't hold them yet). Connect one on the Accounts page to get started."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Backup"
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              api()
                .localBackup.setGlobalPaused(!status.globalPaused)
                .catch(() => {})
            }
            className="flex h-9 items-center gap-2 rounded-full border border-border px-4 text-sm text-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)]"
          >
            {status.globalPaused ? (
              <>
                <Play className="h-4 w-4" /> Resume backups
              </>
            ) : (
              <>
                <Pause className="h-4 w-4" /> Pause all
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-shadow duration-200 ease-standard hover:shadow-gcard"
          >
            <Plus className="h-4 w-4" /> Back up a folder
          </button>
        </div>
      }
    >
      {status.globalPaused ? (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-drive-variant px-4 py-2.5 text-xs text-muted-foreground">
          <Pause className="h-3.5 w-3.5" /> All backups are paused. Scheduled
          runs will not start until you resume.
        </p>
      ) : null}

      {status.vaultMode ? (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-drive-variant px-4 py-2.5 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" /> Backups are paused while vault mode
          is on (Settings → Encrypt everything).
        </p>
      ) : null}

      {sets.length === 0 ? (
        <EmptyState
          icon={DatabaseBackup}
          title="No folders backed up yet"
          description="Pick a local folder and MaxDrive will keep a copy of it in your Drive accounts - uploads, edits, renames and deletions follow automatically on your schedule."
          action={
            <button
              type="button"
              onClick={() => setEditing("new")}
              className="flex h-9 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-shadow duration-200 ease-standard hover:shadow-gcard"
            >
              <Plus className="h-4 w-4" /> Choose a folder
            </button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {sets.map((set) => (
            <SetCard
              key={set.id}
              set={set}
              progress={progress[set.id]}
              onRun={() => run(set)}
              blocked={Boolean(status.vaultMode)}
              onPause={() => togglePaused(set)}
              onEdit={() => setEditing(set)}
              onRestore={() => setRestoring(set)}
              onDelete={() => setDeleting(set)}
              onConfirmDeletions={() => confirmDeletions(set)}
            />
          ))}
        </div>
      )}

      {editing ? (
        <BackupSetDialog
          set={editing === "new" ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}

      {restoring ? (
        <RestoreBrowser set={restoring} onClose={() => setRestoring(null)} />
      ) : null}

      {deleting ? (
        <DeleteSetDialog
          set={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            refresh();
          }}
        />
      ) : null}
    </PageShell>
  );
}

function StatusChip({ state }) {
  const styles = {
    done: "text-primary",
    partial: "text-amber-600 dark:text-amber-400",
    failed: "text-destructive",
    canceled: "text-muted-foreground",
  };
  const labels = {
    done: "Completed",
    partial: "Completed with warnings",
    failed: "Failed",
    canceled: "Canceled",
  };
  if (!state) return null;
  return (
    <span
      className={`text-xs font-medium ${styles[state] || "text-muted-foreground"}`}
    >
      {labels[state] || state}
    </span>
  );
}

function SetCard({
  set,
  progress,
  onRun,
  onPause,
  onEdit,
  onRestore,
  onDelete,
  onConfirmDeletions,
  blocked,
}) {
  const running =
    Boolean(set.activeRun) ||
    (progress &&
      !["done", "partial", "failed", "canceled"].includes(progress.state));
  const live = running ? progress : null;
  const okBytes = set.counts?.ok?.bytes || 0;
  const okFiles = set.counts?.ok?.count || 0;
  const held = set.lastRun?.error === "DELETIONS_HELD";
  const percent =
    live && live.bytesTotal > 0
      ? Math.min(100, (live.bytesDone / live.bytesTotal) * 100)
      : live && live.filesTotal > 0
        ? Math.min(100, (live.filesDone / live.filesTotal) * 100)
        : 0;

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-gcard">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-drive-variant">
          {set.mode === "archive" ? (
            <Archive className="h-5 w-5 text-primary" />
          ) : (
            <FolderOpen className="h-5 w-5 text-primary" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-medium text-foreground">
              {set.name}
            </h3>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {set.mode === "archive" ? "Archive" : "Mirror"}
            </span>
            {set.paused ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Paused
              </span>
            ) : null}
          </div>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            title={set.local_root}
          >
            {set.local_root}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {okFiles
              ? `${okFiles} files · ${formatBytes(okBytes)} backed up`
              : "Nothing backed up yet"}
            {" · "}
            {describeSchedule(set.schedule)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label="Back up now"
            icon={Play}
            onClick={onRun}
            disabled={running || set.paused || blocked}
          />
          <IconButton
            label={set.paused ? "Resume this folder" : "Pause this folder"}
            icon={set.paused ? Play : Pause}
            onClick={onPause}
          />
          <IconButton
            label="Restore files"
            icon={History}
            onClick={onRestore}
          />
          <IconButton
            label="Edit rules and schedule"
            icon={Pencil}
            onClick={onEdit}
          />
          <IconButton
            label="Remove backup"
            icon={Trash2}
            onClick={onDelete}
            danger
          />
        </div>
      </div>

      {live ? (
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {live.state === "scanning"
                ? "Scanning for changes…"
                : `Backing up ${live.filesDone} of ${live.filesTotal} files`}
            </span>
            <span>
              {formatBytes(live.bytesDone)} / {formatBytes(live.bytesTotal)}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-drive-variant">
            <div
              className={`h-full rounded-full bg-primary transition-[width] duration-300 ease-standard ${live.state === "scanning" ? "w-full animate-pulse" : ""}`}
              style={
                live.state === "scanning" ? undefined : { width: `${percent}%` }
              }
            />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            Last run:{" "}
            {set.last_run_at ? formatRelative(set.last_run_at) : "never"}
          </span>
          <StatusChip state={set.last_run_status} />
          {set.next_run_at && !set.paused ? (
            <span>· Next: {new Date(set.next_run_at).toLocaleString()}</span>
          ) : null}
        </div>
      )}

      {held && !running ? (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="min-w-0 flex-1 text-xs text-foreground">
            Many files disappeared locally, so their cloud copies were kept. If
            the deletions were intentional, confirm to mirror them.
          </p>
          <button
            type="button"
            onClick={onConfirmDeletions}
            className="shrink-0 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)]"
          >
            Confirm deletions
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Removing a set: local rows always go; the cloud copy is the user's call. */
function DeleteSetDialog({ set, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);

  const remove = (removeRemote) => {
    setBusy(true);
    window.maxdrive.localBackup
      .deleteSet(set.id, removeRemote)
      .then(() => {
        toast.info(
          removeRemote
            ? `Stopped backing up “${set.name}” and moved its cloud copy to Drive's trash.`
            : `Stopped backing up “${set.name}”. The cloud copy stays in Drive.`,
        );
        onDeleted();
      })
      .catch((err) => {
        toast.error(err.message);
        setBusy(false);
      });
  };

  return (
    <Modal
      title={`Stop backing up “${set.name}”?`}
      subtitle={set.local_root}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton busy={busy} onClick={() => remove(false)}>
            Keep cloud copy
          </ModalButton>
          <ModalButton
            variant="danger"
            busy={busy}
            onClick={() => remove(true)}
          >
            Also trash cloud copy
          </ModalButton>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Your local files are never touched. “Keep cloud copy” leaves the backup
        in Drive (you can delete it there later); “Also trash cloud copy” moves
        it to Drive's trash, where it stays recoverable for 30 days.
      </p>
    </Modal>
  );
}
