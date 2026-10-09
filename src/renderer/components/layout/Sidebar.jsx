import { useState } from "react";
import {
  ChevronRight,
  Clock,
  Cloud,
  DatabaseBackup,
  UploadCloud,
  Folder,
  HardDrive,
  Home,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { AccountAvatar } from "@/components/files/FileIcon";
import { NewMenu } from "@/components/layout/NewMenu";
import { UsageBar } from "@/components/ui/UsageBar";
import { useIpcQuery } from "@/hooks/useIpcQuery";
import { useUiStore } from "@/stores/useUiStore";
import { formatBytes, formatRelative } from "@/lib/format";
import { quotaTotals } from "@/lib/quota";
import { accountName, isDrive } from "@/lib/accounts";

export function Sidebar({ accounts = [], folders = [] }) {
  const { view, navigate } = useUiStore();
  // Accounts starts collapsed so the lower nav (Storage, Settings) stays above
  // the fold on a short window; the footer meter already summarises accounts.
  const [expanded, setExpanded] = useState({ drive: true, accounts: false });

  const toggle = (key) =>
    setExpanded((state) => ({ ...state, [key]: !state[key] }));

  const totals = quotaTotals(accounts);

  return (
    <aside className="flex h-full min-h-0 flex-col gap-3 pb-3 pl-2 pr-1">
      <NewMenu disabled={accounts.length === 0} />

      <nav className="min-h-0 flex-1 overflow-y-auto pr-1">
        <NavItem
          icon={Home}
          label="Home"
          active={view === "home"}
          onClick={() => navigate({ view: "home" })}
        />

        <TreeItem
          icon={Cloud}
          label="MaxDrive"
          open={expanded.drive}
          onToggle={() => toggle("drive")}
          active={view === "browse"}
          onClick={() => navigate({ view: "browse" })}
        >
          {folders.length === 0 ? (
            <p className="py-1 pl-11 pr-3 text-xs text-drive-tertiary">
              No folders yet
            </p>
          ) : (
            folders.map((folder) => (
              <NavItem
                key={folder.id}
                icon={Folder}
                label={folder.name}
                indent
                onClick={() =>
                  navigate({ view: "browse", folderId: folder.id })
                }
              />
            ))
          )}
        </TreeItem>

        <TreeItem
          icon={Users}
          label="Accounts"
          open={expanded.accounts}
          onToggle={() => toggle("accounts")}
          active={view === "accounts"}
          onClick={() => navigate({ view: "accounts" })}
        >
          {accounts.length === 0 ? (
            <p className="py-1 pl-11 pr-3 text-xs text-drive-tertiary">
              None connected
            </p>
          ) : (
            accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                // Each account's Drive is a real node in the index; the scanner
                // creates it as g:<accountId>:root.
                onClick={() =>
                  navigate({ view: "browse", folderId: `g:${account.id}:root` })
                }
                className="flex h-8 w-full items-center gap-3 rounded-full pl-8 pr-3 text-left text-sm text-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)]"
              >
                <AccountAvatar
                  email={account.email}
                  photo={account.photo_url}
                  provider={account.provider}
                  size={18}
                />
                <span className="truncate text-xs">{accountName(account)}</span>
              </button>
            ))
          )}
        </TreeItem>

        <div className="my-2 border-t border-border" />

        <NavItem
          icon={Clock}
          label="Recent"
          active={view === "recent"}
          onClick={() => navigate({ view: "recent" })}
        />
        <NavItem
          icon={Star}
          label="Starred"
          active={view === "starred"}
          onClick={() => navigate({ view: "starred" })}
        />
        <NavItem
          icon={Upload}
          label="Transfers"
          active={view === "transfers"}
          onClick={() => navigate({ view: "transfers" })}
        />
        <NavItem
          icon={Trash2}
          label="Trash"
          active={view === "trash"}
          onClick={() => navigate({ view: "trash" })}
        />

        <div className="my-2 border-t border-border" />

        <NavItem
          icon={HardDrive}
          label="Storage"
          active={view === "storage"}
          onClick={() => navigate({ view: "storage" })}
        />
        <NavItem
          icon={DatabaseBackup}
          label="Backup"
          active={view === "backup"}
          onClick={() => navigate({ view: "backup" })}
        />
        <NavItem
          icon={ShieldCheck}
          label="Secure"
          active={view === "secure"}
          onClick={() => navigate({ view: "secure" })}
        />
        <NavItem
          icon={Settings}
          label="Settings"
          active={view === "settings"}
          onClick={() => navigate({ view: "settings" })}
        />
      </nav>

      {/* Index snapshots are stored on Drive accounts only. */}
      <BackupRow disabled={!accounts.some(isDrive)} />

      <button
        type="button"
        onClick={() => navigate({ view: "storage" })}
        title="Open storage details"
        className="shrink-0 rounded-md border-t border-border px-4 pb-1 pt-3 text-left transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)]"
      >
        <UsageBar percent={totals.percent} className="h-1" />
        <p className="mt-2 text-xs text-muted-foreground">
          {accounts.length
            ? `${formatBytes(totals.used)} of ${formatBytes(totals.limit)} used`
            : "No accounts connected"}
        </p>
      </button>
    </aside>
  );
}

/**
 * "Sync index now" - the user asked for direct control over the index backup,
 * so it lives permanently in the sidebar with a visible freshness stamp.
 */
function BackupRow({ disabled }) {
  const { data: status } = useIpcQuery(
    () => window.maxdrive?.index.status(),
    [],
    ["backupStatus"],
  );

  const label = status?.running
    ? "Backing up…"
    : status?.lastAt
      ? `Backed up ${formatRelative(status.lastAt)}`
      : "Not backed up yet";

  return (
    <button
      type="button"
      disabled={disabled || status?.running}
      onClick={() => window.maxdrive.index.backupNow().catch(() => {})}
      title="Upload the file index to every Google Drive account's MaxDrive/.index folder"
      className="mx-1 flex h-9 shrink-0 items-center gap-3 rounded-full pl-4 pr-3 text-left text-xs text-muted-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)] hover:text-foreground disabled:opacity-50"
    >
      <UploadCloud
        className={`h-4 w-4 shrink-0 ${status?.running ? "animate-pulse text-primary" : ""}`}
      />
      <span className="truncate">{label}</span>
      {status?.lastError ? (
        <span
          className="ml-auto h-2 w-2 shrink-0 rounded-full bg-destructive"
          title={status.lastError}
        />
      ) : null}
    </button>
  );
}

function NavItem({ icon: Icon, label, active, onClick, indent }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`flex h-8 w-full items-center gap-4 rounded-full pr-3 text-left text-sm transition-colors duration-150 ease-standard ${
        indent ? "pl-8" : "pl-4"
      } ${
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-foreground hover:bg-[var(--hover-overlay)]"
      }`}
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** A nav row whose leading chevron expands children without navigating. */
function TreeItem({
  icon: Icon,
  label,
  open,
  onToggle,
  active,
  onClick,
  children,
}) {
  return (
    <div>
      <div
        className={`flex h-8 items-center rounded-full pr-3 transition-colors duration-150 ease-standard ${
          active
            ? "bg-accent font-medium text-accent-foreground"
            : "text-foreground hover:bg-[var(--hover-overlay)]"
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-[var(--hover-overlay)]"
        >
          <ChevronRight
            className={`h-4 w-4 transition-transform duration-200 ease-standard ${
              open ? "rotate-90" : ""
            }`}
          />
        </button>
        <button
          type="button"
          onClick={onClick}
          className="flex h-full min-w-0 flex-1 items-center gap-3 pl-1 text-left text-sm"
        >
          <Icon className="h-5 w-5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </div>
      {open ? <div className="animate-fade-in">{children}</div> : null}
    </div>
  );
}
