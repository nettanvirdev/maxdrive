import { useEffect } from "react";
import { HeaderBar } from "@/components/layout/HeaderBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { TransferTray } from "@/components/transfers/TransferTray";
import { Toaster } from "@/components/ui/Toaster";
import { DropOverlay } from "@/components/files/DropOverlay";
import { AccountsPage } from "@/pages/AccountsPage";
import { BackupPage } from "@/pages/BackupPage";
import { FilesPage } from "@/pages/FilesPage";
import { HomePage } from "@/pages/HomePage";
import { SecurePage } from "@/pages/SecurePage";
import { SettingsPage } from "@/pages/SettingsPage";
import { StoragePage } from "@/pages/StoragePage";
import { TransfersPage } from "@/pages/TransfersPage";
import { KeyboardManager } from "@/shortcuts/KeyboardManager";
import { OverlayHost } from "@/components/command/OverlayHost";
import { useDropUpload } from "@/hooks/useDropUpload";
import { useIpcQuery } from "@/hooks/useIpcQuery";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useTransfersStore } from "@/stores/useTransfersStore";
import { useUiStore } from "@/stores/useUiStore";
import { isDrive } from "@/lib/accounts";

const NONE = [];

export default function App() {
  const { view, folderId, query, windowState } = useUiStore();
  const loadSettings = useSettingsStore((state) => state.load);
  const { refresh: refreshTransfers, applyProgress } = useTransfersStore();
  const { data: accounts = NONE } = useIpcQuery(
    () => window.maxdrive?.accounts.list(),
    [],
    ["accountsChanged", "syncStatus"],
  );
  // No argument => the managed root ("MaxDrive"). Passing null would ask for
  // parent_id IS NULL, which returns that root node itself. The scan and every
  // mutation fire nodesChanged, so the sidebar tree keeps up.
  const { data: rootFolders = NONE } = useIpcQuery(
    () =>
      window.maxdrive?.nodes
        .children()
        .then((nodes) => nodes.filter((n) => n.is_folder)),
    [],
    ["nodesChanged"],
  );

  useEffect(() => {
    loadSettings();
    refreshTransfers();
  }, [loadSettings, refreshTransfers]);

  useEffect(() => {
    const off = [
      window.maxdrive?.on.transfersProgress(applyProgress),
      window.maxdrive?.on.transfersState(refreshTransfers),
      // Auto-lock can fire from the main process at any moment, so the whole
      // app - not just the Secure tab - has to hear about it.
      window.maxdrive?.on.vaultLockChanged((event) =>
        useUiStore.getState().setVaultUnlocked(Boolean(event?.unlocked)),
      ),
      // Vault mode the same way: the header lock, the file list and the
      // commands all read this mirror.
      window.maxdrive?.on.sealChanged?.(useUiStore.getState().refreshSeal),
    ];
    useUiStore.getState().refreshSeal();
    window.maxdrive?.vault
      .status()
      .then((status) =>
        useUiStore.getState().setVaultUnlocked(Boolean(status?.unlocked)),
      )
      .catch(() => {});
    return () => off.forEach((unsubscribe) => unsubscribe?.());
  }, [applyProgress, refreshTransfers]);

  const hasAccounts = accounts.length > 0;
  const rounded = windowState === "normal" ? "rounded-[10px]" : "";

  // Dropped files land in the folder being browsed, else MaxDrive. The Secure
  // page takes its own drops (encrypted into the vault), so a plaintext upload
  // must never happen from there.
  const { dragging, dropProps } = useDropUpload({
    destParentId: view === "browse" ? folderId : null,
    enabled: hasAccounts && view !== "secure",
  });

  return (
    <div
      className={`grid h-full grid-cols-[238px_minmax(0,1fr)] grid-rows-[64px_minmax(0,1fr)] overflow-hidden bg-background ${rounded}`}
    >
      {/* The app's single key listener, and every dialog it can open. */}
      <KeyboardManager />
      <OverlayHost />

      <HeaderBar />
      <Sidebar accounts={accounts} folders={rootFolders} />
      {/* The surface itself never scrolls - each page scrolls its own content
          region, so the title row stays put and the rounded corners keep their
          card background instead of having rows slide under them. */}
      <main
        {...dropProps}
        className="relative mb-4 mr-4 flex min-h-0 flex-col overflow-hidden rounded-xl bg-card"
      >
        <Page
          view={view}
          accounts={accounts}
          hasAccounts={hasAccounts}
          folders={rootFolders}
          folderId={folderId}
          query={query}
        />
        {dragging ? (
          <DropOverlay
            title={`Drop to upload${view === "browse" && folderId ? " here" : " to MaxDrive"}`}
            hint="Folders keep their structure · files land on the account with the most room"
          />
        ) : null}
        {/* One owner for the bottom-right corner. Toasts sit above the tray
            instead of landing on top of it, and neither has to know the
            other's height. */}
        <div className="pointer-events-none absolute bottom-6 right-8 z-40 flex flex-col items-end gap-3">
          <Toaster />
          <TransferTray />
        </div>
      </main>
    </div>
  );
}

function Page({ view, accounts, hasAccounts, folders, folderId, query }) {
  switch (view) {
    case "home":
      return <HomePage folders={folders} hasAccounts={hasAccounts} />;
    case "storage":
      return <StoragePage accounts={accounts} />;
    case "settings":
      return <SettingsPage />;
    // Local backup and the vault store their data on Google Drive only (v1),
    // so S3 accounts neither enable them nor appear in their pickers.
    case "backup": {
      const drive = accounts.filter(isDrive);
      return <BackupPage accounts={drive} hasAccounts={drive.length > 0} />;
    }
    case "secure":
      return <SecurePage hasAccounts={accounts.some(isDrive)} />;
    case "transfers":
      return <TransfersPage />;
    case "accounts":
      return <AccountsPage accounts={accounts} />;
    case "search":
      return (
        <FilesPage source="search" query={query} hasAccounts={hasAccounts} />
      );
    case "recent":
    case "starred":
    case "trash":
      return <FilesPage source={view} hasAccounts={hasAccounts} />;
    case "browse":
    default:
      return (
        <FilesPage
          source="browse"
          folderId={folderId}
          hasAccounts={hasAccounts}
        />
      );
  }
}
