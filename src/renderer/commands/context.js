import { useUiStore } from "@/stores/useUiStore";
import { useSelectionStore, selectedNodes } from "@/stores/useSelectionStore";
import { useOverlayStore } from "@/stores/useOverlayStore";
import { useTransfersStore, isActive } from "@/stores/useTransfersStore";
import { useClipboardStore } from "@/stores/useClipboardStore";

/**
 * A snapshot of everything a command needs to decide whether it applies and
 * what it should act on.
 *
 * Built from store state rather than React props, so the keyboard manager and
 * the command palette can build one without being mounted anywhere particular.
 */
export function buildContext() {
  const ui = useUiStore.getState();
  const selection = useSelectionStore.getState();
  const overlay = useOverlayStore.getState();
  const transfers = useTransfersStore.getState();
  const clipboard = useClipboardStore.getState();

  const nodes = selectedNodes(selection.list, selection.ids);
  // Focus without selection still counts as "the thing you mean" - arrow keys
  // move focus, and pressing F2 immediately after should rename that row.
  const focused =
    nodes[0] ||
    selection.list.find((item) => item.id === selection.focusId) ||
    null;

  const focusedTransfer =
    transfers.transfers.find((item) => item.id === transfers.focusId) || null;

  return {
    view: ui.view,
    folderId: ui.folderId,

    list: selection.list,
    nodes,
    node: focused,
    hasSelection: nodes.length > 0,

    overlayOpen: overlay.stack.length > 0,

    /** Vault mode status (or null) - a UI hint; main enforces the real rule. */
    seal: ui.seal,

    transfers: transfers.transfers,
    focusedTransfer,
    hasActiveTransfers: transfers.transfers.some(isActive),
    hasFailedTransfers: transfers.transfers.some(
      (item) => item.state === "failed",
    ),

    clipboard: clipboard.entries.length ? clipboard : null,

    /** True on views that show a file list the user can act on. */
    inFileView: [
      "browse",
      "search",
      "recent",
      "starred",
      "trash",
      "home",
    ].includes(ui.view),
    inTrash: ui.view === "trash",
  };
}
