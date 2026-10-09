import { useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Lock,
  Monitor,
  Moon,
  Sun,
  Unlock,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ModalButton, ModalError, inputClass } from "@/components/ui/Modal";
import { toast } from "@/stores/useToastStore";
import { PageShell } from "@/components/layout/PageShell";
import { Group, Row, Toggle } from "@/components/ui/SettingsGroup";
import { ShortcutSettings } from "@/components/command/ShortcutSettings";
import { RemoteAccessSettings } from "@/components/server/RemoteAccessSettings";
import { useIpcQuery } from "@/hooks/useIpcQuery";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useUiStore } from "@/stores/useUiStore";
import { useOverlayStore } from "@/stores/useOverlayStore";
import { runCommand } from "@/commands/dispatch";
import { formatBytes } from "@/lib/format";

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

// 0 = never automatically; Re-index on the Accounts page still works.
const S3_RESCAN_OPTIONS = [
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 360, label: "6 hours" },
  { minutes: 0, label: "Manual" },
];

// Vault mode auto-lock; 0 = never.
const AUTOLOCK_OPTIONS = [
  { minutes: 5, label: "5 min" },
  { minutes: 10, label: "10 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 0, label: "Never" },
];

/** The rounded choice pill used by every pill row on this page. */
const pillClass = (active) =>
  `h-9 rounded-full px-3 text-sm transition-colors duration-150 ease-standard ${
    active
      ? "bg-accent font-medium text-accent-foreground"
      : "text-foreground hover:bg-[var(--hover-overlay)]"
  }`;

/** Bordered secondary button - the same shape as Google connection's Change. */
const outlineButton =
  "h-9 shrink-0 rounded-full border border-border px-4 text-sm font-medium text-primary transition-colors hover:bg-[var(--hover-overlay)] disabled:opacity-50";

// Ids match the [data-scheme] blocks in styles/globals.css.
const SCHEMES = [
  { id: "graphite", label: "Graphite", hint: "Neutral greys, monochrome" },
  { id: "drive", label: "Drive", hint: "Google Drive blue" },
  { id: "midnight", label: "Midnight", hint: "True black for OLED" },
];

/** A theme card: the scheme's light and dark halves side by side. */
function SchemeCard({ id, label, hint, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-lg border p-2 text-left transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)] ${
        selected ? "border-primary ring-1 ring-primary" : "border-border"
      }`}
    >
      <div className="flex overflow-hidden rounded-md border border-border">
        <SchemePreview id={id} />
        <SchemePreview id={id} dark />
      </div>
      <div className="mt-2 flex items-center gap-1.5 px-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {selected ? <Check className="h-4 w-4 text-primary" /> : null}
      </div>
      <p className="px-0.5 text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}

/**
 * A miniature window - shell with sidebar, main panel, two cards - painted by
 * the scheme's own tokens: data-scheme (and .dark) scope the CSS variables to
 * this subtree, whatever the app's current scheme is.
 */
function SchemePreview({ id, dark = false }) {
  return (
    <div
      data-scheme={id}
      className={`flex h-20 flex-1 gap-1 bg-background p-1.5 ${dark ? "dark" : ""}`}
    >
      <div className="flex w-1/4 flex-col gap-1 pt-1">
        <span className="h-1.5 w-3/4 rounded-full bg-primary" />
        <span className="h-1.5 w-full rounded-full bg-accent" />
        <span className="h-1.5 w-2/3 rounded-full bg-foreground opacity-20" />
      </div>
      <div className="flex flex-1 flex-col gap-1 rounded bg-card p-1.5">
        <span className="h-1.5 w-1/2 rounded-full bg-foreground opacity-60" />
        <div className="grid flex-1 grid-cols-2 gap-1">
          <span className="rounded-sm bg-drive-folder" />
          <span className="rounded-sm bg-drive-folder" />
        </div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const settings = useSettingsStore();

  return (
    <PageShell title="Settings">
      <Group title="Appearance">
        <Row label="Theme" hint="Light, dark, or follow Windows.">

          <div className="flex gap-2">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => settings.update({ theme: id })}
                className={`flex h-9 items-center gap-2 rounded-full px-4 text-sm transition-colors duration-150 ease-standard ${
                  settings.theme === id
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-foreground hover:bg-[var(--hover-overlay)]"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </Row>
        <div className="p-4">
          <p className="text-sm text-foreground">Color scheme</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Each scheme has a light and a dark version; the theme above picks
            which one you see.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {SCHEMES.map((scheme) => (
              <SchemeCard
                key={scheme.id}
                {...scheme}
                selected={settings.colorScheme === scheme.id}
                onSelect={() => settings.update({ colorScheme: scheme.id })}
              />
            ))}
          </div>
        </div>
      </Group>

      <Group title="Startup and background">
        <Toggle
          label="Start MaxDrive when I sign in to Windows"
          hint="Launches minimised to the system tray so queued transfers resume on their own."
          checked={settings.openAtLogin}
          onChange={(openAtLogin) => settings.update({ openAtLogin })}
        />
        <Toggle
          label="Keep running in the tray when I close the window"
          hint="Uploads and downloads continue in the background. Quit from the tray menu to stop completely."
          checked={settings.minimizeToTray}
          onChange={(minimizeToTray) => settings.update({ minimizeToTray })}
        />
        <Toggle
          label="Resume interrupted transfers automatically"
          hint="On launch, unfinished uploads pick up from the last byte Google confirmed."
          checked={settings.autoResumeTransfers}
          onChange={(autoResumeTransfers) =>
            settings.update({ autoResumeTransfers })
          }
        />
      </Group>

      <Group title="Storage">
        <Row
          label="Headroom per account"
          hint="Space left untouched on each Drive so an account is never filled to the brim."
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="0"
              max="1000"
              step="50"
              value={settings.headroomMb}
              onChange={(event) =>
                settings.update({ headroomMb: Number(event.target.value) })
              }
              className="w-48 accent-[var(--primary)]"
            />
            <span className="w-16 text-sm text-muted-foreground">
              {settings.headroomMb} MB
            </span>
          </div>
        </Row>
        <Row
          label="Check S3 buckets for changes"
          hint="S3 has no change feed, so MaxDrive re-lists each bucket on this schedule. Large buckets cost more requests per check."
        >
          <div className="flex gap-1">
            {S3_RESCAN_OPTIONS.map(({ minutes, label }) => (
              <button
                key={minutes}
                type="button"
                onClick={() => settings.update({ s3RescanMinutes: minutes })}
                className={pillClass(settings.s3RescanMinutes === minutes)}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
      </Group>

      <SealGroup />

      <GoogleClientGroup />

      <RemoteAccessSettings />

      <RestoreGroup />
      <ShortcutSettings />
      <AboutGroup />
    </PageShell>
  );
}

/**
 * Vault mode: every new upload is encrypted with a public key on this PC, so
 * uploads keep working while locked - the password only opens files. Its
 * password and recovery key are separate from the Secure page's vault.
 */
function SealGroup() {
  const seal = useUiStore((state) => state.seal);
  const refreshSeal = useUiStore((state) => state.refreshSeal);
  const openDialog = useOverlayStore((state) => state.openDialog);

  if (!seal) return null;

  const apply = (call) =>
    call(window.maxdrive.seal)
      .catch((err) => toast.error(err.message))
      .finally(refreshSeal);

  if (!seal.configured) {
    return (
      <Group title="Encrypt everything (vault mode)">
        <div className="flex items-start gap-6 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">
              Encrypt every upload before it leaves this PC
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Uploads keep working even while locked - the password is only
              needed to open files. Local folder backups pause while this is on,
              and files already in your Drives are left as they are.
            </p>
          </div>
          <button
            type="button"
            onClick={() => openDialog("sealSetup")}
            className={outlineButton}
          >
            Set up
          </button>
        </div>
      </Group>
    );
  }

  return (
    <Group title="Encrypt everything (vault mode)">
      <Row
        label={seal.unlocked ? "Unlocked" : "Locked"}
        hint={
          seal.unlocked
            ? "Encrypted files show their real names and open normally."
            : "Encrypted files show as “Encrypted file” until you unlock."
        }
      >
        <button
          type="button"
          onClick={() => runCommand(seal.unlocked ? "seal.lock" : "seal.unlock")}
          className={`flex items-center gap-2 ${outlineButton}`}
        >
          {seal.unlocked ? (
            <Lock className="h-4 w-4" />
          ) : (
            <Unlock className="h-4 w-4" />
          )}
          {seal.unlocked ? "Lock" : "Unlock"}
        </button>
      </Row>
      <Toggle
        label="Encrypt all new uploads"
        hint={
          seal.enabled
            ? "Local folder backups are paused while this is on."
            : "Drag-and-drop, Upload and uploads from paired devices are encrypted on this PC first."
        }
        checked={Boolean(seal.enabled)}
        onChange={(enabled) => apply((seal) => seal.setEnabled(enabled))}
      />
      <Row label="Lock automatically" hint="After this long without activity.">
        <div className="flex gap-1">
          {AUTOLOCK_OPTIONS.map(({ minutes, label }) => (
            <button
              key={minutes}
              type="button"
              onClick={() => apply((seal) => seal.setAutolock(minutes))}
              className={pillClass(seal.autolockMinutes === minutes)}
            >
              {label}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Password" hint="Separate from the Secure page's master password.">
        <button
          type="button"
          onClick={() => openDialog("sealPassword")}
          className={outlineButton}
        >
          Change password
        </button>
      </Row>
    </Group>
  );
}

/** Version and where the index lives - the two things worth knowing when something breaks. */
function AboutGroup() {
  const { data: info } = useIpcQuery(() => window.maxdrive?.app.info(), []);

  if (!info) return null;

  return (
    <Group title="About">
      <div className="p-4">
        <p className="text-sm text-foreground">MaxDrive {info.version}</p>
        <p className="mt-0.5 break-all text-xs text-muted-foreground">
          Index and logs: {info.userData}
        </p>
      </div>
    </Group>
  );
}

/**
 * The OAuth client is entered here and stored encrypted by main. It is
 * write-only from this side: main never sends the ID or the secret back, since
 * this screen is visible to anyone the app is shared with.
 */
function GoogleClientGroup() {
  const { data: status, reload } = useIpcQuery(
    () => window.maxdrive?.auth.credentials(),
    [],
  );
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!status) return null;

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await window.maxdrive.auth.setCredentials({ clientId, clientSecret });
      setEditing(false);
      setClientId("");
      setClientSecret("");
      reload();
      toast.success("Google credentials saved");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  return (
    <Group title="Google connection">
      <div className="flex items-start gap-3 p-4">
        {status.ready ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-drive-sheets" />
        ) : (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-drive-slides" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            {status.ready
              ? "Connected to Google"
              : "Google connection not configured"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {status.source === "stored"
              ? "Using the OAuth client you saved, stored encrypted on this PC."
              : status.source === "env"
                ? "Using GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from .env."
                : "Paste the Client ID and secret of your Google Cloud OAuth client (Desktop app). See docs/guides/google-cloud-setup.md in the MaxDrive repository."}
          </p>
        </div>
        {status.ready && !editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="h-9 shrink-0 rounded-full border border-border px-4 text-sm font-medium text-primary transition-colors hover:bg-[var(--hover-overlay)]"
          >
            Change
          </button>
        ) : null}
      </div>

      {editing || !status.ready ? (
        <form onSubmit={save} className="space-y-3 p-4">
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID (…apps.googleusercontent.com)"
            aria-label="Client ID"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Client secret"
            aria-label="Client secret"
            autoComplete="off"
            className={inputClass}
          />
          {status.ready ? (
            <p className="text-xs text-muted-foreground">
              Accounts connected with a different client will need to be
              reconnected.
            </p>
          ) : null}
          <ModalError>{error}</ModalError>
          <div className="flex justify-end gap-2">
            {editing ? (
              <ModalButton type="button" onClick={cancel}>
                Cancel
              </ModalButton>
            ) : null}
            <ModalButton
              type="submit"
              variant="primary"
              busy={busy}
              disabled={busy || !clientId.trim() || !clientSecret.trim()}
            >
              Save
            </ModalButton>
          </div>
        </form>
      ) : null}
    </Group>
  );
}

/**
 * The Windows-reinstall path: list every index snapshot found in the cloud and
 * let the user swap one in. The current index is kept aside as .pre-restore.
 */
function RestoreGroup() {
  const [candidates, setCandidates] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setCandidates(await window.maxdrive.index.listRestoreCandidates());
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (candidate) => {
    setBusy(true);
    try {
      const result = await window.maxdrive.index.restoreFrom(
        candidate.accountId,
        candidate.fileId,
        candidate.name,
      );
      setMessage(
        `Restored ${result.nodes} entries. Re-syncing with Google Drive now.`,
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title="Index backup and restore">
      <div className="p-4">
        <p className="text-sm text-foreground">
          Restore the file index from a cloud backup
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          After reinstalling Windows, reconnect one account and pull the latest
          snapshot from its MaxDrive/.index folder. Newer generations are listed
          first.
        </p>
        <button
          type="button"
          onClick={load}
          disabled={busy}
          className="mt-3 h-9 rounded-full border border-border px-4 text-sm font-medium text-primary transition-colors hover:bg-[var(--hover-overlay)] disabled:opacity-50"
        >
          {busy
            ? "Working…"
            : candidates
              ? "Refresh list"
              : "Find cloud backups"}
        </button>

        {message ? (
          <p className="mt-3 text-xs text-muted-foreground">{message}</p>
        ) : null}

        {candidates?.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            No snapshots found yet - use “Backed up” in the sidebar to create
            one.
          </p>
        ) : null}

        {candidates?.length ? (
          <div className="mt-3 divide-y divide-border rounded-md border border-border">
            {candidates.slice(0, 8).map((candidate) => (
              <div
                key={`${candidate.accountId}:${candidate.fileId}`}
                className="flex items-center gap-3 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">
                    Generation {candidate.generation}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {candidate.email} · {formatBytes(candidate.size)} ·{" "}
                    {candidate.createdTime
                      ? new Date(candidate.createdTime).toLocaleString()
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirming(candidate)}
                  disabled={busy}
                  className="h-8 shrink-0 rounded-full px-3 text-xs font-medium text-primary hover:bg-[var(--hover-overlay)] disabled:opacity-50"
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {confirming ? (
        <ConfirmDialog
          title="Replace the current index?"
          message={`Generation ${confirming.generation} from ${confirming.email} will become your file index. Your files in Google Drive are not touched, and the current index is kept locally as .pre-restore.`}
          confirmLabel="Restore index"
          danger
          onConfirm={() => restore(confirming)}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </Group>
  );
}
