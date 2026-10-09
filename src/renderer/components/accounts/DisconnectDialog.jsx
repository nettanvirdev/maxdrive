import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal, ModalButton, ModalError } from "@/components/ui/Modal";
import { formatBytes } from "@/lib/format";
import { accountName, isS3, s3Location } from "@/lib/accounts";

/**
 * Disconnecting is the one destructive account action, so it says exactly what
 * lives on that account first, and defaults to keeping the index rows - the
 * files still physically exist in Drive, and reconnecting the same account
 * adopts them again.
 */
export function DisconnectDialog({ account, onClose, onDone }) {
  const [impact, setImpact] = useState(null);
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    window.maxdrive.accounts
      .disconnectImpact(account.id)
      .then(setImpact)
      .catch((err) => setError(err.message));
  }, [account.id]);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.maxdrive.accounts.disconnect(account.id, purge);
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const s3 = isS3(account);
  const name = accountName(account);

  return (
    <Modal
      title={s3 ? "Remove this storage?" : "Disconnect this account?"}
      subtitle={s3 ? s3Location(account) : account.email}
      label={`${s3 ? "Remove" : "Disconnect"} ${name}`}
      icon={
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-drive-variant">
          <AlertTriangle className="h-4 w-4 text-destructive" />
        </span>
      }
      width={480}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="danger" busy={busy} onClick={disconnect}>
            {s3 ? "Remove" : "Disconnect"}
          </ModalButton>
        </>
      }
    >
      <p className="text-sm text-foreground">
        {impact
          ? `${impact.files.toLocaleString()} file${
              impact.files === 1 ? "" : "s"
            } (${formatBytes(impact.bytes)}) physically live on this account.`
          : "Checking what lives on this account…"}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {s3
          ? "Nothing is deleted from the bucket. MaxDrive only forgets its access keys."
          : "Nothing is deleted from Google Drive. MaxDrive only forgets its sign-in."}
      </p>

      <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm text-foreground transition-colors duration-150 hover:bg-[var(--hover-overlay)]">
        <input
          type="checkbox"
          checked={purge}
          onChange={(event) => setPurge(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
        />
        <span>
          Also remove its files from the MaxDrive index
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Leave this off to keep browsing them; reconnecting the same account
            restores them either way.
          </span>
        </span>
      </label>

      <ModalError>{error}</ModalError>
    </Modal>
  );
}
