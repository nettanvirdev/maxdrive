import { useEffect, useState } from "react";
import {
  AlertTriangle,
  FolderPlus,
  HardDrive,
  KeyRound,
  Lock,
  ShieldCheck,
} from "lucide-react";
import {
  Modal,
  ModalButton,
  ModalError,
  ModalSection,
  inputClass,
} from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { NameDialog } from "@/components/ui/NameDialog";
import { RecoveryKeyReveal, SecretInput } from "@/components/vault/VaultSetup";
import { Select } from "@/components/ui/Select";
import { formatBytes } from "@/lib/format";
import { isS3 } from "@/lib/accounts";
import { toast } from "@/stores/useToastStore";

const api = () => window.maxdrive?.vault;

/** Rename, and New folder - the same single-field shape. */
export function VaultNameDialog({ mode, item, parentId, onClose }) {
  const creating = mode === "newFolder";
  return (
    <NameDialog
      title={creating ? "New folder" : `Rename “${item?.name}”`}
      icon={creating ? <FolderPlus className="h-5 w-5 text-primary" /> : null}
      width={420}
      initial={creating ? "" : item?.name || ""}
      placeholder={creating ? "Folder name" : "New name"}
      submitLabel={creating ? "Create" : "Rename"}
      onSubmit={(name) =>
        creating ? api().newFolder(parentId, name) : api().rename(item.id, name)
      }
      onClose={onClose}
    >
      {creating ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          Only the name changes. What Drive stores keeps its meaningless
          filename either way.
        </p>
      )}
    </NameDialog>
  );
}

export function VaultDeleteDialog({ items, onClose, onDone }) {
  const many = items.length > 1;
  return (
    <ConfirmDialog
      title={
        many ? `Delete ${items.length} items?` : `Delete “${items[0]?.name}”?`
      }
      message={`This erases the encrypted copies from every account holding them. There is no trash for the vault - deleting here is immediate and permanent.${
        items.some((i) => i.isFolder)
          ? " Everything inside the selected folders goes too."
          : ""
      }`}
      confirmLabel="Delete permanently"
      danger
      onClose={onClose}
      onConfirm={async () => {
        await api().remove(items.map((i) => i.id));
        toast.success(many ? `${items.length} items deleted.` : "Deleted.");
        onDone?.();
      }}
    />
  );
}

export function VaultDetailsDialog({ item, onClose }) {
  const [details, setDetails] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api()
      .details(item.id)
      .then(setDetails)
      .catch((err) => setError(err.message));
  }, [item.id]);

  const Row = ({ label, value }) => (
    <div className="flex items-baseline gap-4 px-4 py-2.5">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 break-words text-sm text-foreground">
        {value}
      </span>
    </div>
  );

  return (
    <Modal
      title={item.name}
      subtitle={item.isFolder ? "Folder" : item.mime || "File"}
      width={480}
      onClose={onClose}
      footer={
        <ModalButton variant="primary" onClick={onClose}>
          Done
        </ModalButton>
      }
    >
      {error ? <ModalError>{error}</ModalError> : null}
      {details ? (
        <>
          <ModalSection className="divide-y divide-border">
            {!item.isFolder ? (
              <Row label="Size" value={formatBytes(details.size)} />
            ) : null}
            {!item.isFolder ? (
              <Row
                label="Encrypted size"
                value={formatBytes(details.blobSize || 0)}
              />
            ) : null}
            <Row
              label="Added"
              value={new Date(details.createdAt).toLocaleString()}
            />
            <Row
              label="Modified"
              value={new Date(details.modifiedAt).toLocaleString()}
            />
            {!item.isFolder ? (
              <Row label="Encryption" value={details.encryption} />
            ) : null}
          </ModalSection>

          {!item.isFolder ? (
            <ModalSection title="Stored on" className="divide-y divide-border">
              {details.copyDetail.length ? (
                details.copyDetail.map((copy) => (
                  <div
                    key={copy.accountId}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {copy.email}
                    </span>
                    <span
                      className={`shrink-0 text-xs ${
                        copy.state === "ok"
                          ? "text-drive-sheets"
                          : "text-muted-foreground"
                      }`}
                    >
                      {copy.state === "ok" ? "Secured" : copy.state}
                    </span>
                  </div>
                ))
              ) : (
                <p className="px-4 py-2.5 text-sm text-muted-foreground">
                  Not stored yet.
                </p>
              )}
            </ModalSection>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </Modal>
  );
}

/** Change the master password - re-wraps the key, never re-uploads files. */
export function VaultPasswordDialog({ onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = () => {
    if (next.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    api()
      .changePassword(current, next, useRecovery)
      .then(() => {
        toast.success("Master password changed.");
        onClose();
      })
      .catch((err) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <Modal
      title="Change master password"
      icon={<Lock className="h-5 w-5 text-primary" />}
      subtitle="Your files stay exactly where they are - only the key that opens them is re-locked."
      width={440}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" busy={busy} onClick={submit}>
            Change password
          </ModalButton>
        </>
      }
    >
      <SecretInput
        recovery={useRecovery}
        value={current}
        autoFocus
        onChange={(event) => setCurrent(event.target.value)}
        placeholder={useRecovery ? "XXXXX-XXXXX-XXXXX-…" : "Current password"}
        onToggle={() => {
          setUseRecovery((value) => !value);
          setCurrent("");
          setError(null);
        }}
        toggleLabel={
          useRecovery
            ? "Use my current password instead"
            : "I forgot my password - use recovery key"
        }
      />
      <input
        type="password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        placeholder="New password"
        className={`${inputClass} mt-2`}
      />
      <input
        type="password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
        placeholder="Confirm new password"
        className={`${inputClass} mt-2`}
      />
      <p className="mt-3 text-xs text-muted-foreground">
        Your existing recovery key keeps working after this.
      </p>
      <ModalError>{error}</ModalError>
    </Modal>
  );
}

/**
 * Issue a replacement recovery key. The old one stops working the moment this
 * succeeds, so the key is revealed only after the password check passes and the
 * dialog will not close until it has been saved or copied.
 */
export function VaultNewRecoveryKeyDialog({ onClose }) {
  const [password, setPassword] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [saved, setSaved] = useState(false);

  const submit = () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    api()
      .regenerateRecoveryKey(password, useRecovery)
      .then((result) => {
        setRecoveryKey(result.recoveryKey);
        setBusy(false);
      })
      .catch((err) => {
        setError(err.message);
        setBusy(false);
      });
  };

  if (recoveryKey) {
    return (
      <Modal
        title="Your new recovery key"
        icon={<KeyRound className="h-5 w-5 text-primary" />}
        subtitle="Shown once. The previous recovery key no longer works."
        width={440}
        // Escape and the scrim must not discard a key that can never be shown
        // again, so closing is refused until it has been written down.
        onClose={
          saved
            ? onClose
            : () => toast.error("Save or copy the key before closing.")
        }
        footer={
          <ModalButton variant="primary" disabled={!saved} onClick={onClose}>
            {saved ? "I've saved it" : "Save or copy it first"}
          </ModalButton>
        }
      >
        <RecoveryKeyReveal
          recoveryKey={recoveryKey}
          onSaved={() => setSaved(true)}
        />
      </Modal>
    );
  }

  return (
    <Modal
      title="New recovery key"
      icon={<KeyRound className="h-5 w-5 text-primary" />}
      subtitle="Confirm you can already open the vault to issue a replacement key."
      width={440}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" busy={busy} onClick={submit}>
            Generate key
          </ModalButton>
        </>
      }
    >
      <SecretInput
        recovery={useRecovery}
        value={password}
        autoFocus
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
        placeholder={useRecovery ? "Current recovery key" : "Master password"}
        onToggle={() => {
          setUseRecovery((value) => !value);
          setPassword("");
          setError(null);
        }}
        toggleLabel={
          useRecovery
            ? "Use my master password instead"
            : "Use my current recovery key instead"
        }
      />
      <p className="mt-3 text-xs text-muted-foreground">
        Your files and password are untouched - this only replaces the backup
        way in. The key you had before will stop working.
      </p>
      <ModalError>{error}</ModalError>
    </Modal>
  );
}

/** Restore a vault found in Drive on a machine that has never seen it. */
export function VaultRecoveryDialog({ onClose, onDone }) {
  const [scan, setScan] = useState(null);
  const [secret, setSecret] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api()
      .recoverScan()
      .then(setScan)
      .catch((err) => setError(err.message));
  }, []);

  const submit = () => {
    setBusy(true);
    setError(null);
    api()
      .recoverRun(secret, useRecovery)
      .then((result) => {
        toast.success(`Vault restored - ${result.items} item(s).`);
        onDone?.();
        onClose();
      })
      .catch((err) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <Modal
      title="Restore your vault"
      icon={<ShieldCheck className="h-5 w-5 text-primary" />}
      subtitle="Found an existing vault in your connected accounts."
      width={460}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            busy={busy}
            disabled={!secret || !scan?.found}
            onClick={submit}
          >
            Restore
          </ModalButton>
        </>
      }
    >
      {scan && !scan.found ? (
        <p className="text-sm text-muted-foreground">
          No vault was found in the accounts connected right now. Connect the
          account that held it and try again.
        </p>
      ) : (
        <>
          {scan ? (
            <ModalSection title="Found in" className="divide-y divide-border">
              {scan.accounts.map((entry) => (
                <div
                  key={entry.accountId}
                  className="flex items-center gap-3 px-4 py-2.5"
                >
                  <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {entry.email}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {entry.blobs} file{entry.blobs === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </ModalSection>
          ) : (
            <p className="text-sm text-muted-foreground">
              Looking for a vault…
            </p>
          )}

          <SecretInput
            recovery={useRecovery}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && secret && submit()}
            placeholder={useRecovery ? "Recovery key" : "Master password"}
            className="mt-4"
            onToggle={() => {
              setUseRecovery((v) => !v);
              setSecret("");
            }}
            toggleLabel={
              useRecovery
                ? "Use the master password"
                : "Use my recovery key instead"
            }
          />
        </>
      )}
      <ModalError>{error}</ModalError>
    </Modal>
  );
}

/** Vault storage settings: which accounts, and how many copies. */
export function VaultAccountsDialog({ onClose }) {
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(null);

  const load = () => {
    Promise.all([
      api().accounts(),
      api().getSettings(),
      window.maxdrive.accounts.list(),
    ])
      .then(([accountData, settingsData, all]) => {
        // The vault can only live on Google Drive (v1) - never offer S3.
        const s3 = new Set(all.filter(isS3).map((account) => account.id));
        setData({
          ...accountData,
          available: (accountData.available || []).filter(
            (entry) => !s3.has(entry.accountId),
          ),
        });
        setSettings(settingsData);
      })
      .catch((err) => setError(err.message));
  };

  useEffect(load, []);

  const add = (accountId) => {
    api()
      .addAccount(accountId)
      .then(() => {
        toast.success("Account added to the vault.");
        load();
      })
      .catch((err) => setError(err.message));
  };

  const changeCopies = (copies) => {
    api()
      .setSettings({ copies: Number(copies) })
      .then((next) => {
        setSettings(next);
        toast.info(
          Number(copies) === 1
            ? "New files will be stored on one account."
            : `New files will be kept on ${copies} accounts.`,
        );
      })
      .catch((err) => setError(err.message));
  };

  const changeAutolock = (minutes) => {
    api()
      .setSettings({ autolockMinutes: Number(minutes) })
      .then(setSettings)
      .catch((err) => setError(err.message));
  };

  if (removing) {
    return (
      <VaultAccountRemoveDialog
        account={removing}
        onClose={() => setRemoving(null)}
        onDone={() => {
          setRemoving(null);
          load();
        }}
      />
    );
  }

  return (
    <Modal
      title="Vault storage"
      icon={<ShieldCheck className="h-5 w-5 text-primary" />}
      subtitle="Which Google Drive accounts hold your encrypted files."
      width={520}
      onClose={onClose}
      footer={
        <ModalButton variant="primary" onClick={onClose}>
          Done
        </ModalButton>
      }
    >
      <ModalSection title="Accounts in use" className="divide-y divide-border">
        {data?.accounts?.length ? (
          data.accounts.map((entry) => (
            <div
              key={entry.accountId}
              className="flex items-center gap-3 px-4 py-3"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  entry.health === "ok" ? "bg-drive-sheets" : "bg-destructive"
                }`}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {entry.email}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {entry.state === "draining"
                    ? "Moving files off this account…"
                    : entry.health !== "ok"
                      ? "Needs reconnecting"
                      : `${entry.okCopies} file${entry.okCopies === 1 ? "" : "s"}${
                          entry.pendingCopies
                            ? ` · ${entry.pendingCopies} in progress`
                            : ""
                        }${entry.freeBytes != null ? ` · ${formatBytes(entry.freeBytes)} free` : ""}`}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setRemoving(entry)}
                className="shrink-0 rounded-full px-3 py-1 text-xs text-primary transition-colors duration-150 hover:bg-[var(--hover-overlay)]"
              >
                Remove
              </button>
            </div>
          ))
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            No accounts chosen yet.
          </p>
        )}
      </ModalSection>

      {data?.available?.length ? (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Add an account
          </p>
          <div className="flex flex-wrap gap-2">
            {data.available.map((entry) => (
              <button
                key={entry.accountId}
                type="button"
                onClick={() => add(entry.accountId)}
                className="rounded-full border border-border px-3 py-1.5 text-xs text-foreground transition-colors duration-150 hover:bg-[var(--hover-overlay)]"
              >
                + {entry.email}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {settings ? (
        <>
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Copies of each file
            </p>
            <Select
              value={settings.copies}
              onChange={changeCopies}
              aria-label="Copies of each file"
              className="w-full"
              options={[
                { value: 1, label: "1 copy", hint: "Uses the least storage" },
                {
                  value: 2,
                  label: "2 copies",
                  hint: "Survives losing one account",
                },
                { value: 3, label: "3 copies", hint: "Maximum redundancy" },
              ]}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Applies to files added from now on; existing files are adjusted in
              the background.
            </p>
          </div>

          <div className="mt-4">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Lock the vault automatically
            </p>
            <Select
              value={settings.autolockMinutes}
              onChange={changeAutolock}
              aria-label="Auto-lock"
              className="w-full"
              options={[
                { value: 2, label: "After 2 minutes idle" },
                { value: 10, label: "After 10 minutes idle" },
                { value: 30, label: "After 30 minutes idle" },
                { value: 0, label: "Only when I quit MaxDrive" },
              ]}
            />
          </div>
        </>
      ) : null}

      <ModalError>{error}</ModalError>
    </Modal>
  );
}

/** The safety gate before an account stops hosting vault files. */
function VaultAccountRemoveDialog({ account, onClose, onDone }) {
  const [impact, setImpact] = useState(null);
  const [mode, setMode] = useState("drain");
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api()
      .removalImpact(account.accountId)
      .then((result) => {
        setImpact(result);
        setMode(result.canDrain && result.soleCount ? "drain" : "force");
      })
      .catch((err) => setError(err.message));
  }, [account.accountId]);

  const submit = () => {
    setBusy(true);
    setError(null);
    api()
      .removeAccount(
        account.accountId,
        mode,
        mode === "force" ? deleteRemote : false,
      )
      .then(() => {
        toast.success(
          mode === "drain"
            ? "Moving files off that account…"
            : "Account removed from the vault.",
        );
        onDone?.();
      })
      .catch((err) => {
        setError(err.message);
        setBusy(false);
      });
  };

  const atRisk = impact?.soleCount > 0;

  return (
    <Modal
      title={`Stop using ${account.email}?`}
      icon={
        atRisk ? (
          <AlertTriangle className="h-5 w-5 text-destructive" />
        ) : (
          <HardDrive className="h-5 w-5 text-primary" />
        )
      }
      width={480}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant={mode === "force" && atRisk ? "danger" : "primary"}
            busy={busy}
            onClick={submit}
          >
            {mode === "drain" ? "Move files, then remove" : "Remove now"}
          </ModalButton>
        </>
      }
    >
      {!impact ? (
        <p className="text-sm text-muted-foreground">
          Checking what's stored there…
        </p>
      ) : (
        <>
          {atRisk ? (
            <div className="rounded-lg border border-destructive px-3 py-2.5">
              <p className="text-sm text-destructive">
                {impact.soleCount} file
                {impact.soleCount === 1 ? " has" : "s have"} no other copy.
                Removing this account now would leave{" "}
                {impact.soleCount === 1 ? "it" : "them"} unreadable.
              </p>
              {impact.soleNames.length ? (
                <p className="mt-1.5 truncate text-xs text-muted-foreground">
                  {impact.soleNames.join(", ")}
                  {impact.soleCount > impact.soleNames.length ? ", …" : ""}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-foreground">
              Every file stored there also lives on another account, so removing
              it is safe.
            </p>
          )}

          <div className="mt-4 space-y-2">
            {impact.canDrain ? (
              <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 transition-colors duration-150 hover:bg-[var(--hover-overlay)]">
                <input
                  type="radio"
                  checked={mode === "drain"}
                  onChange={() => setMode("drain")}
                  className="mt-1 accent-[var(--primary)]"
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    Move the files first (recommended)
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Copies everything to your other vault accounts, then drops
                    this one automatically.
                  </span>
                </span>
              </label>
            ) : null}

            <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 transition-colors duration-150 hover:bg-[var(--hover-overlay)]">
              <input
                type="radio"
                checked={mode === "force"}
                onChange={() => setMode("force")}
                className="mt-1 accent-[var(--primary)]"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">
                  Remove it right now
                </span>
                <span className="block text-xs text-muted-foreground">
                  {atRisk
                    ? "Those files stop being readable until you add the account back."
                    : "Takes effect immediately."}
                </span>
              </span>
            </label>
          </div>

          {mode === "force" ? (
            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={deleteRemote}
                onChange={(event) => setDeleteRemote(event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--primary)]"
              />
              Also erase the encrypted files from that Drive
            </label>
          ) : null}
        </>
      )}
      <ModalError>{error}</ModalError>
    </Modal>
  );
}
