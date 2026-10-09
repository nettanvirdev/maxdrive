import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  Download,
  Eye,
  FolderPlus,
  Info,
  KeyRound,
  KeySquare,
  Lock,
  Pencil,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/files/EmptyState";
import { ViewModeToggle } from "@/components/files/ViewModeToggle";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { PreviewModal } from "@/components/preview/PreviewModal";
import { DropOverlay } from "@/components/files/DropOverlay";
import { VaultLock, VaultSetup } from "@/components/vault/VaultSetup";
import { VaultGridView, VaultListView } from "@/components/vault/VaultViews";
import {
  VaultAccountsDialog,
  VaultDeleteDialog,
  VaultDetailsDialog,
  VaultNameDialog,
  VaultNewRecoveryKeyDialog,
  VaultPasswordDialog,
  VaultRecoveryDialog,
} from "@/components/vault/VaultDialogs";
import { useVault, useVaultItems, useVaultProgress } from "@/hooks/useVault";
import { useDropUpload } from "@/hooks/useDropUpload";
import { toast } from "@/stores/useToastStore";

const api = () => window.maxdrive?.vault;

/** Files the preview overlay can actually render. */
const previewable = (item) => {
  if (item.isFolder) return false;
  const mime = item.mime || "";
  return (
    /^(image|video|audio|text)\//.test(mime) ||
    mime === "application/pdf" ||
    mime === "application/json"
  );
};

/**
 * The Secure tab. Three states in one page: no vault yet, locked, and open.
 *
 * While locked there is nothing to render - not a file count, not a name. The
 * main process refuses to list anything without the master key, so the empty
 * view here isn't a UI decision that could be worked around.
 */
export function SecurePage({ hasAccounts }) {
  const { status, loading: statusLoading, reload } = useVault();
  const unlocked = Boolean(status?.unlocked);

  const [folderId, setFolderId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [viewMode, setViewMode] = useState("list");
  const [menu, setMenu] = useState(null); // {item, x, y}
  const [dialog, setDialog] = useState(null); // {kind, ...}
  const [preview, setPreview] = useState(null);
  // Sticky: creating the vault makes it configured *and* unlocked, but the
  // recovery key is shown exactly once and only the user can dismiss it.
  const [inSetup, setInSetup] = useState(false);

  const { items, crumbs, loading } = useVaultItems(folderId, unlocked);
  const progress = useVaultProgress();

  const encrypt = useCallback(
    (paths) => {
      toast.info(
        paths.length === 1 ? "Encrypting…" : `Encrypting ${paths.length} files…`,
      );
      return api()
        .upload(paths, folderId)
        .catch((err) => toast.error(err.message));
    },
    [folderId],
  );

  // Drops here go into the vault, encrypted - App's global drop zone stands
  // down on this view so nothing can reach MaxDrive as plaintext.
  const { dragging, dropProps } = useDropUpload({
    enabled: unlocked && hasAccounts,
    onPaths: encrypt,
  });

  // Locking (manually or on idle) must not leave the user staring at a folder
  // they can no longer see into.
  useEffect(() => {
    if (!unlocked) {
      setFolderId(null);
      setSelected(new Set());
      setPreview(null);
      setMenu(null);
    }
  }, [unlocked]);

  const selectedItems = items.filter((item) => selected.has(item.id));

  const onSelect = useCallback((item, event) => {
    setSelected((prev) => {
      if (event?.ctrlKey || event?.metaKey) {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      }
      return new Set([item.id]);
    });
  }, []);

  const open = (item) => {
    if (item.isFolder) {
      setFolderId(item.id);
      setSelected(new Set());
    } else if (previewable(item) && item.available) {
      setPreview(item);
    } else if (!item.available) {
      toast.error("That file isn't available from any connected account yet.");
    } else {
      download([item]);
    }
  };

  const upload = () => {
    window.maxdrive.dialog
      .pickFiles()
      .then((paths) => paths?.length && encrypt(paths))
      .catch((err) => toast.error(err.message));
  };

  const download = (targets) => {
    api()
      .download(targets.map((i) => i.id))
      .then((result) => {
        if (result.queued?.length) {
          toast.success(
            result.queued.length === 1
              ? "Decrypting to your chosen folder…"
              : `Decrypting ${result.queued.length} files…`,
          );
        }
      })
      .catch((err) => toast.error(err.message));
  };

  /* ---------------------------------------------------------- lock states */

  if (statusLoading) return <PageShell title="Secure" />;

  if (!status) {
    return (
      <PageShell title="Secure">
        <EmptyState
          icon={ShieldCheck}
          title="Secure storage is unavailable"
          description="MaxDrive couldn't reach the vault service. Restarting the app usually clears this."
        />
      </PageShell>
    );
  }

  if (!status.configured || inSetup) {
    return (
      <PageShell title="Secure">
        {!hasAccounts ? (
          <EmptyState
            icon={ShieldCheck}
            title="Connect a Google Drive account first"
            description="Your vault stores its encrypted files in your Google Drive accounts (not S3 storage), so MaxDrive needs at least one connected."
          />
        ) : dialog?.kind === "recover" ? (
          <VaultRecoveryDialog
            onClose={() => setDialog(null)}
            onDone={reload}
          />
        ) : (
          <VaultSetup
            recoverable={status.recoverable}
            onRecover={() => setDialog({ kind: "recover" })}
            onRecoveryKey={() => setInSetup(true)}
            onDone={() => {
              setInSetup(false);
              reload();
            }}
          />
        )}
      </PageShell>
    );
  }

  if (!unlocked) {
    return (
      <PageShell title="Secure">
        <VaultLock
          retryAfterMs={status.retryAfterMs}
          onUnlocked={(result) => {
            reload();
            // Unlocked with the recovery key: the password is gone, so land
            // straight in the dialog that replaces it.
            if (result?.usedRecovery) {
              toast.info("Set a new master password to finish recovering.");
              setDialog({ kind: "password" });
            }
          }}
        />
        {dialog?.kind === "recover" ? (
          <VaultRecoveryDialog
            onClose={() => setDialog(null)}
            onDone={reload}
          />
        ) : null}
      </PageShell>
    );
  }

  /* ------------------------------------------------------------- unlocked */

  const title = (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => setFolderId(null)}
        className="flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-0.5 text-[22px] font-normal leading-7 text-foreground transition-colors duration-150 hover:bg-[var(--hover-overlay)]"
      >
        <ShieldCheck className="h-5 w-5 text-primary" />
        Secure
      </button>
      {crumbs.map((crumb, index) => (
        <span key={crumb.id} className="flex min-w-0 items-center gap-1.5">
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          <button
            type="button"
            onClick={() => setFolderId(crumb.id)}
            disabled={index === crumbs.length - 1}
            className="truncate rounded-lg px-1.5 py-0.5 text-[22px] font-normal leading-7 text-foreground transition-colors duration-150 hover:bg-[var(--hover-overlay)] disabled:hover:bg-transparent"
          >
            {crumb.name}
          </button>
        </span>
      ))}
    </div>
  );

  const actions = (
    <div className="flex shrink-0 items-center gap-1">
      {selectedItems.length ? (
        <>
          <IconButton
            icon={Download}
            label="Download"
            onClick={() => download(selectedItems)}
          />
          <IconButton
            icon={Trash2}
            label="Delete"
            onClick={() => setDialog({ kind: "delete", items: selectedItems })}
          />
          <span className="mx-1 h-5 w-px bg-border" />
        </>
      ) : null}
      <ViewModeToggle value={viewMode} onChange={setViewMode} />
      <IconButton
        icon={FolderPlus}
        label="New folder"
        onClick={() => setDialog({ kind: "newFolder" })}
      />
      <IconButton
        icon={KeyRound}
        label="Change master password"
        onClick={() => setDialog({ kind: "password" })}
      />
      <IconButton
        icon={KeySquare}
        label="New recovery key"
        onClick={() => setDialog({ kind: "newRecoveryKey" })}
      />
      <IconButton
        icon={Settings2}
        label="Vault storage"
        onClick={() => setDialog({ kind: "accounts" })}
      />
      <IconButton
        icon={Lock}
        label="Lock vault"
        onClick={() => api().lock().then(reload)}
      />
      <button
        type="button"
        onClick={upload}
        className="ml-1 flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-shadow duration-200 ease-standard hover:shadow-gcard"
      >
        <Upload className="h-4 w-4" />
        Add files
      </button>
    </div>
  );

  const View = viewMode === "list" ? VaultListView : VaultGridView;

  return (
    <div {...dropProps} className="relative h-full min-h-0">
      <PageShell title={title} actions={actions}>
        {loading ? null : items.length ? (
          <View
            items={items}
            progress={progress}
            selected={selected}
            onSelect={onSelect}
            onOpen={open}
            onMenu={(item, x, y) => setMenu({ item, x, y })}
          />
        ) : (
          <EmptyState
            icon={ShieldCheck}
            title={folderId ? "This folder is empty" : "Your vault is empty"}
            description={
              folderId
                ? "Add files here and they'll be encrypted before they leave this computer."
                : "Files you add are encrypted on this computer first. In Google Drive they appear as unreadable data with meaningless names."
            }
            action={
              <button
                type="button"
                onClick={upload}
                className="flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-shadow duration-200 ease-standard hover:shadow-gcard"
              >
                <Upload className="h-4 w-4" />
                Add files
              </button>
            }
          />
        )}

        {menu ? (
          <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
            {previewable(menu.item) && menu.item.available ? (
              <MenuItem
                icon={Eye}
                label="Preview"
                onClick={() => {
                  setPreview(menu.item);
                  setMenu(null);
                }}
              />
            ) : null}
            {!menu.item.isFolder ? (
              <MenuItem
                icon={Download}
                label="Download"
                disabled={!menu.item.available}
                onClick={() => {
                  download([menu.item]);
                  setMenu(null);
                }}
              />
            ) : null}
            <MenuItem
              icon={Pencil}
              label="Rename"
              onClick={() => {
                setDialog({ kind: "rename", item: menu.item });
                setMenu(null);
              }}
            />
            <MenuItem
              icon={Info}
              label="Details"
              onClick={() => {
                setDialog({ kind: "details", item: menu.item });
                setMenu(null);
              }}
            />
            <MenuSeparator />
            <MenuItem
              icon={Trash2}
              label="Delete"
              danger
              onClick={() => {
                setDialog({ kind: "delete", items: [menu.item] });
                setMenu(null);
              }}
            />
          </Menu>
        ) : null}

        {preview ? (
          <PreviewModal
            node={{
              id: preview.id,
              name: preview.name,
              mime: preview.mime,
              size: preview.size,
              vault: true,
            }}
            onClose={() => setPreview(null)}
          />
        ) : null}

        {dialog?.kind === "rename" || dialog?.kind === "newFolder" ? (
          <VaultNameDialog
            mode={dialog.kind}
            item={dialog.item}
            parentId={folderId}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {dialog?.kind === "delete" ? (
          <VaultDeleteDialog
            items={dialog.items}
            onClose={() => setDialog(null)}
            onDone={() => setSelected(new Set())}
          />
        ) : null}
        {dialog?.kind === "details" ? (
          <VaultDetailsDialog
            item={dialog.item}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {dialog?.kind === "accounts" ? (
          <VaultAccountsDialog onClose={() => setDialog(null)} />
        ) : null}
        {dialog?.kind === "password" ? (
          <VaultPasswordDialog onClose={() => setDialog(null)} />
        ) : null}
        {dialog?.kind === "newRecoveryKey" ? (
          <VaultNewRecoveryKeyDialog onClose={() => setDialog(null)} />
        ) : null}
      </PageShell>
      {dragging ? (
        <DropOverlay
          icon={ShieldCheck}
          title="Drop to encrypt into your vault"
          hint="Files are encrypted on this computer before they leave it"
        />
      ) : null}
    </div>
  );
}
