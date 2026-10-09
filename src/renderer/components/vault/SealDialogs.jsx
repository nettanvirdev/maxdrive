import { useEffect, useState } from "react";
import { KeyRound, Lock, ShieldCheck } from "lucide-react";
import {
  Modal,
  ModalButton,
  ModalError,
  inputClass,
} from "@/components/ui/Modal";
import { RecoveryKeyReveal, SecretInput } from "@/components/vault/VaultSetup";
import { useUiStore } from "@/stores/useUiStore";
import { toast } from "@/stores/useToastStore";

/**
 * Dialogs for vault mode ("seal": encrypt every upload). Its password and
 * recovery key are its own - independent of the Secure page's vault - but the
 * reveal and the password⇄recovery field are the same components.
 */
const api = () => window.maxdrive.seal;

/** Same floor and wording as the Secure vault's setup. */
function checkNewPassword(password, confirm) {
  if (password.length < 8) return "Use at least 8 characters.";
  if (password !== confirm) return "The two passwords don't match.";
  return null;
}

/** Password + confirm, then the once-only recovery key. */
export function SealSetupDialog({ onClose }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [saved, setSaved] = useState(false);

  const submit = () => {
    const problem = checkNewPassword(password, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    api()
      .setup(password)
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
        title="Save your recovery key"
        icon={<KeyRound className="h-5 w-5 text-primary" />}
        subtitle="Shown once. It opens your encrypted files if you forget the password."
        width={460}
        // The key can never be shown again, so closing waits until it's kept.
        onClose={
          saved
            ? onClose
            : () => toast.error("Save or copy the key before closing.")
        }
        footer={
          <ModalButton variant="primary" disabled={!saved} onClick={onClose}>
            {saved ? "Done" : "Save or copy it first"}
          </ModalButton>
        }
      >
        <RecoveryKeyReveal
          recoveryKey={recoveryKey}
          kind="seal"
          onSaved={() => setSaved(true)}
        />
      </Modal>
    );
  }

  return (
    <Modal
      title="Set up vault mode"
      icon={<ShieldCheck className="h-5 w-5 text-primary" />}
      subtitle="This password is only for vault mode, not the Secure page."
      width={460}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" busy={busy} onClick={submit}>
            Set up
          </ModalButton>
        </>
      }
    >
      <input
        type="password"
        value={password}
        autoFocus
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password (at least 8 characters)"
        className={inputClass}
      />
      <input
        type="password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
        placeholder="Confirm password"
        className={`${inputClass} mt-2`}
      />
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        There is no password reset. Lose both the password and the recovery key
        you get next and the encrypted files can't be opened by anyone.
      </p>
      <ModalError>{error}</ModalError>
    </Modal>
  );
}

/** Password (or recovery key) to view encrypted files. Closes once open. */
export function SealUnlockDialog({ onClose }) {
  const [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [waitMs, setWaitMs] = useState(
    () => useUiStore.getState().seal?.retryAfterMs || 0,
  );

  // Count the lockout down so the user watches it expire.
  useEffect(() => {
    if (waitMs <= 0) return undefined;
    const timer = setInterval(
      () => setWaitMs((ms) => Math.max(0, ms - 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [waitMs > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    if (!secret || waitMs > 0) return;
    setBusy(true);
    setError(null);
    api()
      .unlock(secret, recovery)
      .then(() => {
        toast.success("Encrypted files unlocked");
        onClose();
      })
      .catch(async (err) => {
        setBusy(false);
        setSecret("");
        if (err.code === "VAULT_RATE_LIMITED") {
          // The IPC envelope carries only message + code, so ask for the wait.
          const status = await api().status().catch(() => null);
          setWaitMs(status?.retryAfterMs || 0);
          setError("Too many attempts. Wait a moment and try again.");
        } else if (err.code === "WRONG_PASSWORD") {
          setError(
            recovery
              ? "That recovery key isn't right."
              : "Wrong password.",
          );
        } else setError(err.message);
      });
  };

  return (
    <Modal
      title="Unlock encrypted files"
      icon={<Lock className="h-5 w-5 text-primary" />}
      subtitle={
        recovery
          ? "Enter the vault mode recovery key you saved."
          : "Enter your vault mode password to open encrypted files."
      }
      width={440}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            busy={busy}
            disabled={waitMs > 0}
            onClick={submit}
          >
            {waitMs > 0
              ? `Try again in ${Math.ceil(waitMs / 1000)}s`
              : "Unlock"}
          </ModalButton>
        </>
      }
    >
      <SecretInput
        recovery={recovery}
        value={secret}
        autoFocus
        onChange={(event) => setSecret(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
        placeholder={recovery ? "XXXXX-XXXXX-XXXXX-…" : "Password"}
        onToggle={() => {
          setRecovery((value) => !value);
          setSecret("");
          setError(null);
        }}
        toggleLabel={
          recovery ? "Use my password instead" : "Use recovery key instead"
        }
      />
      <ModalError>{error}</ModalError>
    </Modal>
  );
}

/** Current + new + confirm. */
export function SealPasswordDialog({ onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = () => {
    const problem = checkNewPassword(next, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    api()
      .changePassword(current, next)
      .then(() => {
        toast.success("Vault mode password changed");
        onClose();
      })
      .catch((err) => {
        setError(
          err.code === "WRONG_PASSWORD"
            ? "The current password is wrong."
            : err.message,
        );
        setBusy(false);
      });
  };

  return (
    <Modal
      title="Change vault mode password"
      icon={<Lock className="h-5 w-5 text-primary" />}
      subtitle="Encrypted files stay as they are - only the key that opens them is re-locked."
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
      <input
        type="password"
        value={current}
        autoFocus
        onChange={(event) => setCurrent(event.target.value)}
        placeholder="Current password"
        className={inputClass}
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
      <ModalError>{error}</ModalError>
    </Modal>
  );
}
