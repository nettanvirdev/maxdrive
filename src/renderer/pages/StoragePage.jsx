import { useState } from "react";
import {
  AlertTriangle,
  Database,
  HardDrive,
  Loader2,
  Plus,
  RotateCw,
} from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { AccountAvatar } from "@/components/files/FileIcon";
import { UsageBar } from "@/components/ui/UsageBar";
import { useConnectAccount } from "@/hooks/useConnectAccount";
import { toast } from "@/stores/useToastStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { quotaTotals } from "@/lib/quota";
import { formatBytes } from "@/lib/format";
import { accountName, isDrive, isS3 } from "@/lib/accounts";
import { runCommand } from "@/commands/dispatch";

export function StoragePage({ accounts = [] }) {
  const { connect, busy, error } = useConnectAccount();
  const [refreshing, setRefreshing] = useState(false);
  const headroom = useSettingsStore((state) => state.headroomMb) * 1024 * 1024;

  // Quota is cached for 15 minutes; this asks Google right now, which matters
  // after deleting things on the web and wondering why the bar didn't move.
  const refresh = async () => {
    setRefreshing(true);
    try {
      await window.maxdrive.accounts.refreshQuota(null, true);
      toast.success("Storage figures updated");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setRefreshing(false);
    }
  };
  const total = quotaTotals(accounts);
  const free = Math.max(total.limit - total.used, 0);

  // A file can't be split across accounts, so the real ceiling is the single
  // emptiest account rather than the combined free space.
  const largestSlot = accounts.reduce((best, a) => {
    const slot = (a.quota_limit ?? 0) - (a.quota_usage ?? 0) - headroom;
    return slot > (best?.slot ?? 0) ? { slot, email: accountName(a) } : best;
  }, null);

  return (
    <PageShell
      title="Storage"
      actions={
        accounts.length ? (
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium text-primary transition-colors hover:bg-[var(--hover-overlay)] disabled:opacity-50"
          >
            <RotateCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        ) : null
      }
    >
      <div className="mb-6 rounded-lg border border-border p-5">
        <div className="flex items-baseline gap-3">
          <HardDrive className="h-5 w-5 self-center text-muted-foreground" />
          <span className="text-2xl text-foreground">
            {formatBytes(total.used)}
          </span>
          <span className="text-sm text-muted-foreground">
            of {formatBytes(total.limit)} used across {accounts.length} account
            {accounts.length === 1 ? "" : "s"}
          </span>
          <span className="ml-auto text-sm text-muted-foreground">
            {formatBytes(free)} free
          </span>
        </div>
        <UsageBar percent={total.percent} className="mt-4 h-2" />
        {largestSlot ? (
          <p className="mt-3 text-xs text-drive-tertiary">
            Largest single file you can upload right now:{" "}
            <span className="text-muted-foreground">
              {formatBytes(Math.max(largestSlot.slot, 0))}
            </span>{" "}
            on {largestSlot.email} - files are never split across accounts.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
        {accounts.map((account) => {
          const used = account.quota_usage ?? 0;
          const limit = account.quota_limit ?? 0;
          const pct = limit ? (used / limit) * 100 : 0;
          const tight = pct >= 90;
          return (
            <div
              key={account.id}
              className="rounded-lg border border-border p-4"
            >
              <div className="flex items-center gap-3">
                <AccountAvatar
                  email={account.email}
                  photo={account.photo_url}
                  provider={account.provider}
                  size={32}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    {accountName(account)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatBytes(used)} of {formatBytes(limit)}
                    {isS3(account) ? " · limit set by you" : ""}
                  </p>
                </div>
                {tight ? (
                  <AlertTriangle
                    className="h-4 w-4 shrink-0 text-destructive"
                    aria-label="Almost full"
                  />
                ) : null}
              </div>
              <UsageBar percent={pct} danger={tight} className="mt-3 h-1.5" />
              <p className="mt-2 text-xs text-drive-tertiary">
                {formatBytes(Math.max(limit - used, 0))} free
              </p>
            </div>
          );
        })}

        <button
          type="button"
          onClick={connect}
          disabled={busy}
          className="flex min-h-[132px] items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:bg-[var(--hover-overlay)] disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {busy
            ? "Waiting for Google…"
            : accounts.length
              ? "Connect another Google account"
              : "Connect a Google account"}
        </button>
        <button
          type="button"
          onClick={() => runCommand("app.connectS3")}
          className="flex min-h-[132px] items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:bg-[var(--hover-overlay)]"
        >
          <Database className="h-4 w-4" />
          Add S3-compatible storage
        </button>
      </div>

      {error ? (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-border bg-drive-variant p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm text-foreground">{error}</p>
        </div>
      ) : null}

      {accounts.some(isDrive) ? (
        <p className="mt-6 text-xs text-drive-tertiary">
          Google counts Gmail and Photos against the same 15 GB pool, so these
          figures reflect total account usage rather than Drive alone.
        </p>
      ) : null}
    </PageShell>
  );
}
