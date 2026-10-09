import { useState } from "react";
import {
  AlertTriangle,
  CloudOff,
  Database,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
} from "lucide-react";
import { DisconnectDialog } from "@/components/accounts/DisconnectDialog";
import { EmptyState } from "@/components/files/EmptyState";
import { AccountAvatar } from "@/components/files/FileIcon";
import { PageShell } from "@/components/layout/PageShell";
import { useConnectAccount } from "@/hooks/useConnectAccount";
import { runCommand } from "@/commands/dispatch";
import { useOverlayStore } from "@/stores/useOverlayStore";
import { toast } from "@/stores/useToastStore";
import { formatBytes } from "@/lib/format";
import { accountName, isS3, s3Location } from "@/lib/accounts";

/**
 * Connect / reconnect / disconnect. The consent screen opens in the system
 * browser, so this page mostly waits - the connecting state has to be obvious
 * or it looks like the button did nothing.
 */
export function AccountsPage({ accounts = [] }) {
  const {
    connect,
    busy: connecting,
    error: connectError,
  } = useConnectAccount();
  const [busy, setBusy] = useState(null);
  const [rowError, setRowError] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);
  const error = connectError || rowError;

  const run = async (key, fn) => {
    setBusy(key);
    setRowError(null);
    try {
      await fn();
    } catch (err) {
      setRowError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const addButtons = (
    <div className="flex shrink-0 items-center gap-2">
      <ConnectButton busy={connecting} onClick={connect} />
      <button
        type="button"
        onClick={() => runCommand("app.connectS3")}
        className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-border px-5 text-sm font-medium text-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)]"
      >
        <Database className="h-4 w-4" />
        Add S3-compatible storage
      </button>
    </div>
  );

  if (!accounts.length) {
    return (
      <PageShell title="Accounts">
        <ErrorBanner error={error} />
        <div className="flex h-full items-center justify-center">
          <EmptyState
            icon={CloudOff}
            title="No accounts connected yet"
            description="Connect Google Drive accounts or S3-compatible buckets and MaxDrive merges them into one drive, deciding where every upload lands."
            action={addButtons}
          />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="Accounts" actions={addButtons}>
      <ErrorBanner error={error} />

      <div className="divide-y divide-border rounded-lg border border-border">
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            busy={busy}
            onReauth={() =>
              // S3 has no sign-in to redo - bad keys are fixed by editing.
              isS3(account)
                ? useOverlayStore.getState().openDialog("s3Account", account)
                : run(`reauth:${account.id}`, () =>
                    window.maxdrive.accounts.reauth(account.id),
                  )
            }
            onRescan={() =>
              run(`scan:${account.id}`, async () => {
                const result = await window.maxdrive.sync.scan(account.id);
                toast.success(
                  `Re-indexed ${accountName(account)}${
                    result?.count != null ? ` - ${result.count} files` : ""
                  }`,
                );
              })
            }
            onDisconnect={() => setDisconnecting(account)}
          />
        ))}
      </div>

      {disconnecting ? (
        <DisconnectDialog
          account={disconnecting}
          onClose={() => setDisconnecting(null)}
          onDone={() =>
            toast.info(
              `${accountName(disconnecting)} ${isS3(disconnecting) ? "removed" : "disconnected"}`,
            )
          }
        />
      ) : null}
    </PageShell>
  );
}

function AccountRow({ account, busy, onReauth, onRescan, onDisconnect }) {
  const s3 = isS3(account);
  const needsReauth = account.auth_state !== "ok";
  const used = account.quota_usage ?? 0;
  const limit = account.quota_limit;
  const usage =
    limit == null
      ? `${formatBytes(used)} used`
      : `${formatBytes(used)} of ${formatBytes(limit)} used`;
  const status =
    account.auth_state === "disconnected" ? "Disconnected" : "Reconnect needed";

  return (
    <div className="flex items-center gap-4 p-4">
      <AccountAvatar
        email={account.email}
        photo={account.photo_url}
        provider={account.provider}
        size={40}
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          {s3 ? accountName(account) : account.display_name || account.email}
        </p>
        {s3 ? (
          <>
            <p className="truncate text-xs text-muted-foreground">
              {s3Location(account)}
            </p>
            <p
              className="truncate text-xs text-drive-tertiary"
              title="S3 buckets have no quota of their own - this is the limit you set"
            >
              {usage} · limit set by you
            </p>
          </>
        ) : (
          <p className="truncate text-xs text-muted-foreground">
            {account.display_name ? `${account.email} · ` : ""}
            {usage}
          </p>
        )}
      </div>

      {needsReauth && s3 ? (
        <button
          type="button"
          onClick={onReauth}
          title="Update this bucket's access keys"
          className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs text-drive-pdf transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)]"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          {status}
        </button>
      ) : needsReauth ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-drive-pdf">
          <AlertTriangle className="h-3.5 w-3.5" />
          {status}
        </span>
      ) : null}

      <div className="flex shrink-0 items-center gap-2">
        <ChipAction
          label="Re-index"
          hint="Rescan this account and rebuild its part of the index"
          icon={RotateCw}
          busy={busy === `scan:${account.id}`}
          onClick={onRescan}
        />
        {s3 ? (
          <ChipAction
            label="Edit"
            hint="Change the name, storage limit or access keys"
            icon={Pencil}
            onClick={onReauth}
          />
        ) : (
          <ChipAction
            label="Reconnect"
            hint="Sign in to this account again"
            icon={RefreshCw}
            busy={busy === `reauth:${account.id}`}
            onClick={onReauth}
          />
        )}
        <ChipAction
          label={s3 ? "Remove" : "Disconnect"}
          hint="Remove this account from MaxDrive"
          icon={Trash2}
          danger
          onClick={onDisconnect}
        />
      </div>
    </div>
  );
}

function ConnectButton({ busy, onClick, label = "Add Google Drive" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-shadow duration-200 ease-standard hover:shadow-gcard disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Plus className="h-4 w-4" />
      )}
      {busy ? "Waiting for Google…" : label}
    </button>
  );
}

/**
 * Icon + label pill, shaped like the location chip in the file list.
 *
 * These were three bare icons before, and re-index / reconnect are a circular
 * arrow either way - indistinguishable at 16px, and picking the wrong one costs
 * a full OAuth round trip. The word is what tells them apart, so the word is not
 * optional.
 */
function ChipAction({ label, hint, icon: Icon, busy, danger, onClick }) {
  return (
    <button
      type="button"
      title={hint || label}
      onClick={onClick}
      disabled={busy}
      className={`flex h-8 shrink-0 items-center gap-2 rounded-full border border-border px-3 text-xs transition-colors duration-150 ease-standard disabled:opacity-50 ${
        danger
          ? "text-muted-foreground hover:border-destructive hover:bg-destructive/10 hover:text-destructive"
          : "text-muted-foreground hover:bg-[var(--hover-overlay)] hover:text-foreground"
      }`}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5 shrink-0" />
      )}
      {label}
    </button>
  );
}

function ErrorBanner({ error }) {
  if (!error) return null;
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-drive-variant p-4">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-drive-pdf" />
      <p className="text-sm text-foreground">{error}</p>
    </div>
  );
}
