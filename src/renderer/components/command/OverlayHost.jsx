import { MoveDialog } from "@/components/files/MoveDialog";
import { ShareDialog } from "@/components/files/ShareDialog";
import { DetailsDialog } from "@/components/files/DetailsDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PreviewModal } from "@/components/preview/PreviewModal";
import { PairDeviceDialog } from "@/components/server/PairDeviceDialog";
import { S3AccountDialog } from "@/components/accounts/S3AccountDialog";
import { NameDialog } from "@/components/ui/NameDialog";
import { ShortcutHelp } from "@/components/command/ShortcutHelp";
import { CommandPalette } from "@/components/command/CommandPalette";
import {
  SealPasswordDialog,
  SealSetupDialog,
  SealUnlockDialog,
} from "@/components/vault/SealDialogs";
import { useOverlayStore } from "@/stores/useOverlayStore";
import { useUiStore } from "@/stores/useUiStore";
import { useSelectionStore } from "@/stores/useSelectionStore";
import { toast } from "@/stores/useToastStore";

/**
 * Renders every overlay from store state, mounted once at the root.
 *
 * Dialogs used to live inside ItemMenu, which meant only the ⋮ menu could open
 * one - a keystroke or the command palette had nothing to render. Hoisting them
 * here is what lets "Rename" mean the same thing however it was invoked.
 */
export function OverlayHost() {
  const dialog = useOverlayStore((state) => state.dialog);
  const preview = useOverlayStore((state) => state.preview);
  const closeDialog = useOverlayStore((state) => state.closeDialog);
  const closePreview = useOverlayStore((state) => state.closePreview);

  const node = dialog?.node || null;

  return (
    <>
      <CommandPalette />
      <ShortcutHelp />

      {dialog?.kind === "rename" && node ? (
        <NameDialog
          title={node.is_folder ? "Rename folder" : "Rename file"}
          subtitle={node.name}
          label={`Rename ${node.name}`}
          width={440}
          initial={node.name}
          selectStem={!node.is_folder}
          submitLabel="Rename"
          onSubmit={(name) =>
            name !== node.name && window.maxdrive.ops.rename(node.id, name)
          }
          onClose={closeDialog}
        />
      ) : null}

      {dialog?.kind === "move" && node ? (
        <MoveDialog node={node} onClose={closeDialog} />
      ) : null}

      {dialog?.kind === "share" && node ? (
        <ShareDialog node={node} onClose={closeDialog} />
      ) : null}

      {dialog?.kind === "details" && node ? (
        <DetailsDialog node={node} onClose={closeDialog} />
      ) : null}

      {dialog?.kind === "deleteForever" && node ? (
        <DeleteForeverDialog onClose={closeDialog} />
      ) : null}

      {dialog?.kind === "newFolder" ? <NewFolderDialog onClose={closeDialog} /> : null}

      {dialog?.kind === "pairDevice" ? <PairDeviceDialog onClose={closeDialog} /> : null}

      {/* node = the S3 account row to edit, or null to add one. */}
      {dialog?.kind === "s3Account" ? (
        <S3AccountDialog account={node} onClose={closeDialog} />
      ) : null}

      {/* Vault mode (encrypt every upload). */}
      {dialog?.kind === "sealSetup" ? <SealSetupDialog onClose={closeDialog} /> : null}
      {dialog?.kind === "sealUnlock" ? <SealUnlockDialog onClose={closeDialog} /> : null}
      {dialog?.kind === "sealPassword" ? (
        <SealPasswordDialog onClose={closeDialog} />
      ) : null}

      {preview ? <PreviewModal node={preview} onClose={closePreview} /> : null}
    </>
  );
}

/** Deletes the whole selection, not just the node the menu was opened on. */
function DeleteForeverDialog({ onClose }) {
  const { ids, list, clear } = useSelectionStore();
  const targets = list.filter((item) => ids.includes(item.id));
  const label =
    targets.length === 1 ? targets[0].name : `${targets.length} items`;

  return (
    <ConfirmDialog
      title="Delete permanently?"
      message={`${label} will be deleted from its storage. This cannot be undone.`}
      confirmLabel="Delete forever"
      danger
      onClose={onClose}
      onConfirm={async () => {
        await window.maxdrive.ops.deleteForever(targets.map((item) => item.id));
        toast.success(`Deleted ${label}`);
        clear();
      }}
    />
  );
}

/**
 * The name prompt for a new folder. Lifted out of NewMenu so Ctrl+Shift+N and
 * the New button reach the same dialog rather than each owning a copy.
 */
function NewFolderDialog({ onClose }) {
  const { view, folderId, navigate } = useUiStore();
  const destination = view === "browse" ? folderId : null;

  return (
    <NameDialog
      title="New folder"
      subtitle={
        destination ? "Created inside the folder you are browsing" : "Created in MaxDrive"
      }
      width={420}
      initial="Untitled folder"
      submitLabel="Create"
      onSubmit={async (name) => {
        const folder = await window.maxdrive.ops.mkdir(destination, name);
        navigate({ view: "browse", folderId: folder.parent_id });
      }}
      onClose={onClose}
    />
  );
}
