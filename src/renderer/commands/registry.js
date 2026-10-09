import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Clipboard,
  Copy,
  Database,
  Download,
  ExternalLink,
  FolderInput,
  FolderPlus,
  FolderOpen,
  DatabaseBackup,
  HardDrive,
  Home,
  Info,
  Keyboard,
  Link2,
  ListChecks,
  Lock,
  Unlock,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Scissors,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Star,
  StarOff,
  Trash2,
  Upload,
  Undo2,
  UserPlus,
  X,
} from "lucide-react";

import { useUiStore } from "@/stores/useUiStore";
import { useSelectionStore } from "@/stores/useSelectionStore";
import { useOverlayStore } from "@/stores/useOverlayStore";
import { useClipboardStore } from "@/stores/useClipboardStore";
import { useTransfersStore, isActive } from "@/stores/useTransfersStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { toast } from "@/stores/useToastStore";
import { onDrive } from "@/lib/accounts";

const api = () => window.maxdrive;

/** Uploads and new folders land in the folder being browsed, else MaxDrive. */
function destination() {
  const { view, folderId } = useUiStore.getState();
  return view === "browse" ? folderId : null;
}

const ids = (nodes) => nodes.map((node) => node.id);

/**
 * Vault-mode files can't be read while locked, so asking to open one means
 * "unlock first". Returns true when it opened the unlock dialog instead.
 */
function unlockFirst(nodes) {
  if (!nodes.some((node) => node?.sealLocked)) return false;
  useOverlayStore.getState().openDialog("sealUnlock");
  return true;
}

const plural = (nodes, word) =>
  nodes.length === 1 ? nodes[0].name : `${nodes.length} ${word}s`;

/**
 * The command registry: every action the app can perform, defined exactly once.
 *
 * A command owns its own availability (`when`) and its behaviour (`run`), so the
 * keyboard, the ⋮ menu, the toolbar and the command palette are all just
 * different ways of reaching the same entry. Before this existed the same
 * trash/star/download logic was written twice - once in ItemMenu and again in
 * FileActions - and the two had already drifted apart.
 *
 * `when` is also what makes a shortcut context-aware: Space previews a file in
 * the file list and pauses a job in the transfer list because two commands
 * claim the same chord under mutually exclusive conditions.
 */
export const COMMANDS = [
  /* ------------------------------------------------------------ navigation */
  {
    id: "search.focus",
    title: "Search files",
    category: "Navigation",
    icon: Search,
    run: () => focusSearch(),
  },
  {
    id: "palette.open",
    title: "Show all commands",
    category: "Navigation",
    icon: ListChecks,
    run: () => useOverlayStore.getState().openPalette(),
  },
  {
    id: "nav.back",
    title: "Back",
    category: "Navigation",
    icon: ArrowLeft,
    when: () => useUiStore.getState().history.length > 0,
    run: () => useUiStore.getState().back(),
  },
  {
    id: "nav.forward",
    title: "Forward",
    category: "Navigation",
    icon: ArrowRight,
    when: () => useUiStore.getState().future.length > 0,
    run: () => useUiStore.getState().forward(),
  },
  {
    id: "nav.parent",
    title: "Go to parent folder",
    category: "Navigation",
    icon: ArrowUp,
    when: (ctx) => ctx.view === "browse" && Boolean(ctx.folderId),
    run: async (ctx) => {
      const path = await api().nodes.path(ctx.folderId);
      // path is root → … → current; the entry before the last is the parent.
      const parent = path[path.length - 2];
      useUiStore.getState().openFolder(parent ? parent.id : null);
    },
  },
  {
    id: "nav.root",
    title: "Go to MaxDrive root",
    category: "Navigation",
    icon: HardDrive,
    run: () => useUiStore.getState().openFolder(null),
  },
  {
    id: "nav.home",
    title: "Open Home",
    category: "Navigation",
    icon: Home,
    run: () => useUiStore.getState().navigate({ view: "home" }),
  },
  {
    id: "nav.transfers",
    title: "Open background jobs",
    category: "Navigation",
    icon: RefreshCw,
    run: () => useUiStore.getState().navigate({ view: "transfers" }),
  },
  {
    id: "nav.backup",
    title: "Open backup",
    category: "Navigation",
    icon: DatabaseBackup,
    run: () => useUiStore.getState().navigate({ view: "backup" }),
  },
  {
    id: "nav.secure",
    title: "Open secure storage",
    category: "Navigation",
    icon: ShieldCheck,
    run: () => useUiStore.getState().navigate({ view: "secure" }),
  },
  {
    id: "vault.lock",
    title: "Lock the vault",
    category: "Navigation",
    icon: Lock,
    // Only offered when there is something to lock - the command palette
    // shouldn't advertise a vault to someone who hasn't made one.
    when: () => useUiStore.getState().vaultUnlocked === true,
    run: () => api().vault.lock(),
  },
  {
    id: "seal.unlock",
    title: "Unlock encrypted files",
    category: "Navigation",
    icon: Unlock,
    when: (ctx) => Boolean(ctx.seal?.configured && !ctx.seal.unlocked),
    run: () => useOverlayStore.getState().openDialog("sealUnlock"),
  },
  {
    id: "seal.lock",
    title: "Lock encrypted files",
    category: "Navigation",
    icon: Lock,
    when: (ctx) => Boolean(ctx.seal?.unlocked),
    run: () => api().seal.lock(),
  },
  {
    id: "nav.storage",
    title: "Open storage dashboard",
    category: "Navigation",
    icon: HardDrive,
    run: () => useUiStore.getState().navigate({ view: "storage" }),
  },
  {
    id: "nav.accounts",
    title: "Open accounts",
    category: "Navigation",
    icon: UserPlus,
    run: () => useUiStore.getState().navigate({ view: "accounts" }),
  },
  {
    id: "nav.settings",
    title: "Open settings",
    category: "Navigation",
    icon: Settings,
    run: () => useUiStore.getState().navigate({ view: "settings" }),
  },
  {
    id: "nav.trash",
    title: "Open trash",
    category: "Navigation",
    icon: Trash2,
    run: () => useUiStore.getState().navigate({ view: "trash" }),
  },
  {
    id: "nav.starred",
    title: "Open starred",
    category: "Navigation",
    icon: Star,
    run: () => useUiStore.getState().navigate({ view: "starred" }),
  },

  /* -------------------------------------------------------- file creation */
  {
    id: "file.upload",
    title: "Upload files",
    category: "Files",
    icon: Upload,
    // The Secure page has its own encrypted "Add files"; a plain upload there
    // would put plaintext in MaxDrive.
    when: (ctx) => ctx.view !== "secure",
    run: async () => {
      const paths = await api().dialog.pickFiles();
      if (!paths.length) return;
      const result = await api().transfers.enqueuePaths(paths, destination());
      toast.success(
        `${result.files} file${result.files === 1 ? "" : "s"} queued`,
      );
    },
  },
  {
    id: "file.uploadFolder",
    title: "Upload folder",
    category: "Files",
    icon: FolderInput,
    when: (ctx) => ctx.view !== "secure",
    run: async () => {
      const folder = await api().dialog.pickFolder();
      if (!folder) return;
      const result = await api().transfers.enqueuePaths([folder], destination());
      toast.success(
        `${result.files} file${result.files === 1 ? "" : "s"} queued`,
      );
    },
  },
  {
    id: "file.newFolder",
    title: "Create new folder",
    category: "Files",
    icon: FolderPlus,
    run: () => useOverlayStore.getState().openDialog("newFolder"),
  },

  /* ------------------------------------------------------ file operations */
  {
    id: "file.open",
    title: "Open",
    category: "Files",
    icon: FolderOpen,
    when: (ctx) => Boolean(ctx.node),
    run: (ctx) => {
      const node = ctx.node;
      if (unlockFirst([node])) return;
      if (node.is_folder) useUiStore.getState().openFolder(node.id);
      else if (node.is_google_doc && node.web_view_link) {
        api().shell.openExternal(node.web_view_link);
      } else useOverlayStore.getState().openPreview(node);
    },
  },
  {
    id: "file.preview",
    title: "Preview",
    category: "Files",
    icon: Play,
    when: (ctx) => Boolean(ctx.node) && !ctx.node.is_folder,
    run: (ctx) =>
      unlockFirst([ctx.node]) ||
      useOverlayStore.getState().openPreview(ctx.node),
  },
  {
    id: "file.openExternal",
    title: "Open in Google Drive",
    category: "Files",
    icon: ExternalLink,
    // Drive only holds ciphertext for a sealed file - nothing to look at there.
    when: (ctx) =>
      onDrive(ctx.node) && Boolean(ctx.node.web_view_link) && !ctx.node.sealed,
    run: (ctx) => api().shell.openExternal(ctx.node.web_view_link),
  },
  {
    id: "file.rename",
    title: "Rename",
    category: "Files",
    icon: Pencil,
    when: (ctx) => Boolean(ctx.node) && !ctx.inTrash,
    run: (ctx) =>
      unlockFirst([ctx.node]) ||
      useOverlayStore.getState().openDialog("rename", ctx.node),
  },
  {
    id: "file.move",
    title: "Move to folder",
    category: "Files",
    icon: FolderInput,
    when: (ctx) => Boolean(ctx.node) && !ctx.inTrash,
    run: (ctx) => useOverlayStore.getState().openDialog("move", ctx.node),
  },
  {
    id: "file.trash",
    title: "Move to trash",
    category: "Files",
    icon: Trash2,
    danger: true,
    when: (ctx) => ctx.hasSelection && !ctx.inTrash,
    run: async (ctx) => {
      await api().ops.trash(ids(ctx.nodes));
      toast.success(`${plural(ctx.nodes, "item")} moved to trash`);
      useSelectionStore.getState().clear();
    },
  },
  {
    id: "file.restore",
    title: "Restore from trash",
    category: "Files",
    icon: Undo2,
    when: (ctx) => ctx.hasSelection && ctx.nodes.every((node) => node.trashed),
    run: async (ctx) => {
      await api().ops.restore(ids(ctx.nodes));
      toast.success(`Restored ${plural(ctx.nodes, "item")}`);
      useSelectionStore.getState().clear();
    },
  },
  {
    id: "file.deleteForever",
    title: "Delete permanently",
    category: "Files",
    icon: Trash2,
    danger: true,
    when: (ctx) => ctx.hasSelection,
    run: (ctx) =>
      useOverlayStore.getState().openDialog("deleteForever", ctx.node),
  },
  {
    id: "file.star",
    title: "Add to starred",
    category: "Files",
    icon: Star,
    when: (ctx) => Boolean(ctx.node) && !ctx.node.starred,
    run: async (ctx) => {
      await api().ops.star(ctx.node.id, true);
      toast.success(`Starred ${ctx.node.name}`);
    },
  },
  {
    id: "file.unstar",
    title: "Remove from starred",
    category: "Files",
    icon: StarOff,
    when: (ctx) => Boolean(ctx.node?.starred),
    run: async (ctx) => {
      await api().ops.star(ctx.node.id, false);
      toast.success(`Removed star from ${ctx.node.name}`);
    },
  },
  {
    id: "file.download",
    title: "Download",
    category: "Files",
    icon: Download,
    when: (ctx) =>
      ctx.hasSelection &&
      ctx.nodes.some(
        (node) => !node.is_folder && !node.is_google_doc && node.drive_file_id,
      ),
    run: async (ctx) => {
      const targets = ctx.nodes.filter(
        (node) => !node.is_folder && !node.is_google_doc && node.drive_file_id,
      );
      if (unlockFirst(targets)) return;
      for (const node of targets)
        await api().transfers.enqueueDownload(node.id);
      toast.info(`Downloading ${plural(targets, "file")}`);
    },
  },
  {
    id: "file.share",
    title: "Share",
    category: "Files",
    icon: Link2,
    // Sharing is a Drive permission; S3 objects have no equivalent in v1.
    // A sealed file would only share ciphertext, so it isn't offered.
    when: (ctx) =>
      onDrive(ctx.node) &&
      !ctx.node.sealed &&
      Boolean(ctx.node.drive_file_id && ctx.node.account_id),
    run: (ctx) => useOverlayStore.getState().openDialog("share", ctx.node),
  },
  {
    id: "file.copyLink",
    title: "Copy link",
    category: "Files",
    icon: Link2,
    when: (ctx) => Boolean(ctx.node?.share_link),
    run: async (ctx) => {
      await navigator.clipboard.writeText(ctx.node.share_link);
      toast.success("Link copied");
    },
  },
  {
    id: "file.createLink",
    title: "Create shareable link",
    category: "Files",
    icon: Link2,
    when: (ctx) =>
      onDrive(ctx.node) &&
      !ctx.node.sealed &&
      Boolean(ctx.node.drive_file_id && ctx.node.account_id) &&
      !ctx.node.share_link,
    run: async (ctx) => {
      const { link } = await api().share.createLink(ctx.node.id);
      await navigator.clipboard.writeText(link);
      toast.success("Link created and copied");
    },
  },
  {
    id: "file.details",
    title: "File information",
    category: "Files",
    icon: Info,
    when: (ctx) => Boolean(ctx.node),
    run: (ctx) => useOverlayStore.getState().openDialog("details", ctx.node),
  },
  {
    id: "file.showLocation",
    title: "Show file location",
    category: "Files",
    icon: FolderOpen,
    when: (ctx) => Boolean(ctx.node?.parent_id),
    run: (ctx) => useUiStore.getState().openFolder(ctx.node.parent_id),
  },
  {
    id: "file.selectAll",
    title: "Select all",
    category: "Files",
    icon: ListChecks,
    when: (ctx) => ctx.inFileView && ctx.list.length > 0,
    run: (ctx) => useSelectionStore.getState().selectAll(ctx.list),
  },

  /* ---------------------------------------------------------- clipboard */
  {
    id: "file.cut",
    title: "Cut",
    category: "Files",
    icon: Scissors,
    when: (ctx) => ctx.hasSelection && !ctx.inTrash,
    run: (ctx) => {
      useClipboardStore.getState().cut(ctx.nodes);
      toast.info(`${plural(ctx.nodes, "item")} ready to move`);
    },
  },
  {
    id: "file.copy",
    title: "Copy",
    category: "Files",
    icon: Copy,
    when: (ctx) => ctx.hasSelection && !ctx.inTrash,
    run: (ctx) => {
      useClipboardStore.getState().copy(ctx.nodes);
      toast.info(`${plural(ctx.nodes, "item")} copied`);
    },
  },
  {
    id: "file.paste",
    title: "Paste",
    category: "Files",
    icon: Clipboard,
    when: (ctx) => Boolean(ctx.clipboard) && ctx.inFileView && !ctx.inTrash,
    run: async (ctx) => {
      const { entries, mode } = ctx.clipboard;
      const target = destination();
      if (mode === "cut") {
        await api().ops.move(ids(entries), target);
        toast.success(`Moved ${plural(entries, "item")}`);
      } else {
        const result = await api().ops.copy(ids(entries), target);
        toast.success(
          `Copied ${result.copied} item${result.copied === 1 ? "" : "s"}`,
        );
      }
      useClipboardStore.getState().clear();
    },
  },
  {
    id: "file.duplicate",
    title: "Duplicate",
    category: "Files",
    icon: Copy,
    when: (ctx) =>
      ctx.hasSelection &&
      !ctx.inTrash &&
      ctx.nodes.every((node) => !node.is_folder),
    run: async (ctx) => {
      const result = await api().ops.copy(ids(ctx.nodes), ctx.node.parent_id);
      toast.success(
        `Duplicated ${result.copied} item${result.copied === 1 ? "" : "s"}`,
      );
    },
  },

  /* ----------------------------------------------------- background jobs */
  {
    id: "job.toggle",
    title: "Pause or resume job",
    category: "Background jobs",
    icon: Play,
    when: (ctx) =>
      Boolean(ctx.focusedTransfer) && isActive(ctx.focusedTransfer),
    run: (ctx) => {
      const store = useTransfersStore.getState();
      if (ctx.focusedTransfer.state === "paused")
        store.resume(ctx.focusedTransfer.id);
      else store.pause(ctx.focusedTransfer.id);
    },
  },
  {
    id: "job.retry",
    title: "Retry job",
    category: "Background jobs",
    icon: RotateCw,
    when: (ctx) => ctx.focusedTransfer?.state === "failed",
    run: (ctx) => useTransfersStore.getState().retry(ctx.focusedTransfer.id),
  },
  {
    id: "job.retryAll",
    title: "Retry all failed jobs",
    category: "Background jobs",
    icon: RotateCw,
    when: (ctx) => ctx.hasFailedTransfers,
    run: async (ctx) => {
      const failed = ctx.transfers.filter((item) => item.state === "failed");
      for (const item of failed) await api().transfers.retry(item.id);
      useTransfersStore.getState().refresh();
      toast.info(
        `Retrying ${failed.length} job${failed.length === 1 ? "" : "s"}`,
      );
    },
  },
  {
    id: "job.cancel",
    title: "Cancel job",
    category: "Background jobs",
    icon: X,
    danger: true,
    when: (ctx) =>
      Boolean(ctx.focusedTransfer) && isActive(ctx.focusedTransfer),
    run: (ctx) => useTransfersStore.getState().cancel(ctx.focusedTransfer.id),
  },
  {
    id: "job.remove",
    title: "Remove job from list",
    category: "Background jobs",
    icon: X,
    // Only finished jobs - removing a running one would orphan the worker
    // rather than stop it, which is what Cancel is for.
    when: (ctx) =>
      Boolean(ctx.focusedTransfer) && !isActive(ctx.focusedTransfer),
    run: (ctx) => useTransfersStore.getState().remove(ctx.focusedTransfer.id),
  },
  {
    id: "job.clear",
    title: "Clear finished jobs",
    category: "Background jobs",
    icon: X,
    when: (ctx) => ctx.transfers.some((item) => !isActive(item)),
    run: () => useTransfersStore.getState().clearCompleted(),
  },
  {
    id: "job.pauseAll",
    title: "Pause all transfers",
    category: "Background jobs",
    icon: Play,
    when: (ctx) => ctx.hasActiveTransfers,
    run: async () => {
      await api().transfers.pauseAll();
      useTransfersStore.getState().refresh();
    },
  },
  {
    id: "job.resumeAll",
    title: "Resume all transfers",
    category: "Background jobs",
    icon: Play,
    when: (ctx) => ctx.transfers.some((item) => item.state === "paused"),
    run: async () => {
      await api().transfers.resumeAll();
      useTransfersStore.getState().refresh();
    },
  },

  /* ------------------------------------------------------------- the app */
  {
    id: "app.refresh",
    title: "Refresh current folder",
    category: "Application",
    icon: RefreshCw,
    run: async () => {
      await api().accounts.refreshQuota(null, true);
      toast.success("Refreshed");
    },
  },
  {
    id: "app.rebuildIndex",
    title: "Rebuild index",
    category: "Application",
    icon: RefreshCw,
    run: async () => {
      const result = await api().sync.scan(null);
      toast.success(`Indexed ${result?.count ?? 0} files`);
    },
  },
  {
    id: "app.backupNow",
    title: "Back up index now",
    category: "Application",
    icon: HardDrive,
    run: async () => {
      await api().index.backupNow();
      toast.success("Index backed up");
    },
  },
  {
    id: "app.connectAccount",
    title: "Add Google Drive account",
    category: "Application",
    icon: UserPlus,
    run: async () => {
      await api().accounts.connect();
      toast.success("Account connected");
    },
  },
  {
    id: "app.connectS3",
    title: "Add S3-compatible storage",
    category: "Application",
    icon: Database,
    run: () => useOverlayStore.getState().openDialog("s3Account"),
  },
  {
    id: "server.addDevice",
    title: "Add a device (phone or AI)",
    category: "Application",
    icon: Smartphone,
    run: () => useOverlayStore.getState().openDialog("pairDevice"),
  },
  {
    id: "server.manageDevices",
    title: "Manage connected devices",
    category: "Application",
    icon: Smartphone,
    run: () => useUiStore.getState().navigate({ view: "settings" }),
  },
  {
    id: "app.toggleViewMode",
    title: "Switch between list and grid",
    category: "Application",
    icon: ListChecks,
    run: () => {
      const ui = useUiStore.getState();
      ui.setViewMode(ui.viewMode === "list" ? "grid" : "list");
    },
  },
  {
    id: "app.toggleTheme",
    title: "Switch theme",
    category: "Application",
    icon: Settings,
    run: () => useSettingsStore.getState().cycleTheme(),
  },
  {
    id: "app.shortcutHelp",
    title: "Keyboard shortcuts",
    category: "Application",
    icon: Keyboard,
    run: () => useOverlayStore.getState().openShortcutHelp(),
  },
  {
    id: "app.closeOverlay",
    title: "Close",
    category: "Application",
    icon: X,
    palette: false, // Escape only - listing "Close" in the palette is noise.
    when: (ctx) => ctx.overlayOpen || ctx.hasSelection,
    run: (ctx) => {
      if (ctx.overlayOpen) useOverlayStore.getState().closeTop();
      else useSelectionStore.getState().clear();
    },
  },
];

/** The search box is the one control a command has to reach through the DOM. */
function focusSearch() {
  const input = document.querySelector("[data-search-input]");
  if (input) {
    input.focus();
    input.select();
  }
}

export const COMMAND_MAP = new Map(
  COMMANDS.map((command) => [command.id, command]),
);

/** A command with no `when` is always available. */
export function isAvailable(command, ctx) {
  if (!command) return false;
  try {
    return command.when ? Boolean(command.when(ctx)) : true;
  } catch {
    return false;
  }
}
