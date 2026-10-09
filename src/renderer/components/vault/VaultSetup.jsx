import { useEffect, useState } from "react";
import {
  AlertTriangle,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { ModalButton, ModalError, inputClass } from "@/components/ui/Modal";
import { toast } from "@/stores/useToastStore";

const api = () => window.maxdrive?.vault;

/** Rough strength read-out - guidance, never a gate beyond the 8-char floor. */
function strengthOf(password) {
  if (!password) return { label: "", pct: 0, tone: "" };
  let score = Math.min(4, Math.floor(password.length / 5));
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^\w\s]/.test(password)) score += 1;
  if (/\s/.test(password)) score += 1; // passphrases are good
  const pct = Math.min(100, (score / 7) * 100);
  if (pct < 35) return { label: "Weak", pct, tone: "bg-destructive" };
  if (pct < 70) return { label: "Fair", pct, tone: "bg-drive-docs" };
  return { label: "Strong", pct, tone: "bg-drive-sheets" };
}

/** The shared card frame both the setup and lock screens sit in. */
export function VaultCard({
  icon: Icon,
  title,
  subtitle,
  children,
  tone = "primary",
}) {
  return (
    <div className="mx-auto mt-6 w-full max-w-[440px]">
      <div className="rounded-xl border border-border bg-card p-7 shadow-gcard">
        <span
          className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
            tone === "danger"
              ? "bg-destructive/10 text-destructive"
              : "bg-drive-variant text-primary"
          }`}
        >
          <Icon className="h-6 w-6" />
        </span>
        <h2 className="text-lg font-medium text-foreground">{title}</h2>
        {subtitle ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {subtitle}
          </p>
        ) : null}
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}

/**
 * The once-only recovery key with its Save / Copy buttons. Either one counts as
 * having kept it, which is what `onSaved` reports.
 */
export function RecoveryKeyReveal({ recoveryKey, onSaved, kind = "vault" }) {
  const saveKey = () =>
    api()
      .saveRecoveryKey(recoveryKey, kind)
      .then((result) => {
        if (!result.saved) return;
        onSaved();
        toast.success("Recovery key saved.");
      })
      .catch((err) => toast.error(err.message));

  const copyKey = () =>
    navigator.clipboard.writeText(recoveryKey).then(() => {
      onSaved();
      toast.success("Recovery key copied.");
    });

  return (
    <>
      <p className="select-all break-all rounded-lg border border-border bg-drive-variant px-4 py-3 text-center font-mono text-sm tracking-wide text-foreground">
        {recoveryKey}
      </p>
      <div className="mt-3 flex justify-center gap-2">
        <ModalButton onClick={saveKey}>Save to file</ModalButton>
        <ModalButton onClick={copyKey}>Copy</ModalButton>
      </div>
      <p className="mt-3 flex gap-2 rounded-lg border border-destructive px-3 py-2.5 text-xs leading-relaxed text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        Anyone who has this key can open your secure files. Keep it somewhere
        offline - not in the folders you back up.
      </p>
    </>
  );
}

/**
 * A password field that can switch to taking the recovery key instead, with
 * the switch link under it. The caller owns `recovery` and what a switch resets.
 */
export function SecretInput({
  recovery,
  onToggle,
  toggleLabel,
  className = "",
  ...input
}) {
  return (
    <>
      <input
        type={recovery ? "text" : "password"}
        {...input}
        className={`${inputClass} ${className} ${recovery ? "font-mono" : ""}`}
      />
      <button
        type="button"
        onClick={onToggle}
        className="mt-2 text-xs text-primary hover:underline"
      >
        {toggleLabel}
      </button>
    </>
  );
}

/**
 * First run. Two steps, and the second one is not skippable by accident: the
 * recovery key is the only thing standing between a forgotten password and
 * permanently unreadable files, and it is shown exactly once.
 */
export function VaultSetup({ onDone, onRecoveryKey, recoverable, onRecover }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [saved, setSaved] = useState(false);

  const strength = strengthOf(password);

  const create = () => {
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    api()
      .setup(password)
      .then((result) => {
        setRecoveryKey(result.recoveryKey);
        setBusy(false);
        // Setup unlocks the vault and fires `vaultChanged`, so the page would
        // otherwise decide the vault is ready and unmount this card — taking
        // the only copy of the recovery key with it.
        onRecoveryKey?.();
      })
      .catch((err) => {
        setError(err.message);
        setBusy(false);
      });
  };

  if (recoveryKey) {
    return (
      <VaultCard
        icon={KeyRound}
        title="Save your recovery key"
        subtitle="This is the only way into your vault if you forget the master password. It is shown once and cannot be retrieved later."
      >
        <RecoveryKeyReveal
          recoveryKey={recoveryKey}
          onSaved={() => setSaved(true)}
        />

        <ModalButton
          variant="primary"
          onClick={onDone}
          disabled={!saved}
          className="mt-4 w-full"
        >
          {saved
            ? "I've saved it - open my vault"
            : "Save or copy the key first"}
        </ModalButton>
      </VaultCard>
    );
  }

  return (
    <VaultCard
      icon={ShieldCheck}
      title="Create your vault"
      subtitle="Files you put here are encrypted on this computer before they ever reach Google Drive. Nobody with access to your Drive - including Google - can read them."
    >
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
        Master password
      </label>
      <input
        type="password"
        value={password}
        autoFocus
        onChange={(event) => setPassword(event.target.value)}
        placeholder="At least 8 characters"
        className={inputClass}
      />
      {password ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-drive-variant">
            <span
              className={`block h-full rounded-full transition-all duration-300 ease-standard ${strength.tone}`}
              style={{ width: `${strength.pct}%` }}
            />
          </span>
          <span className="text-xs text-muted-foreground">
            {strength.label}
          </span>
        </div>
      ) : null}

      <label className="mb-1.5 mt-4 block text-xs font-medium text-muted-foreground">
        Confirm password
      </label>
      <input
        type="password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && create()}
        placeholder="Type it again"
        className={inputClass}
      />

      <p className="mt-4 flex gap-2 rounded-lg border border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-drive-docs" />
        There is no password reset. If you lose both the password and the
        recovery key you get next, the files are gone for good - that is what
        makes them private.
      </p>

      <ModalError>{error}</ModalError>

      <ModalButton
        variant="primary"
        onClick={create}
        busy={busy}
        className="mt-4 w-full"
      >
        Create vault
      </ModalButton>

      {recoverable ? (
        <button
          type="button"
          onClick={onRecover}
          className="mt-3 w-full text-center text-xs text-primary hover:underline"
        >
          A vault already exists in your Drive - restore it instead
        </button>
      ) : null}
    </VaultCard>
  );
}

/** Shown every time the vault is closed. Reveals nothing until it opens. */
export function VaultLock({ onUnlocked, retryAfterMs = 0 }) {
  const [secret, setSecret] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [waitMs, setWaitMs] = useState(retryAfterMs);

  // Count the penalty down so the user watches it expire rather than guessing.
  useEffect(() => setWaitMs(retryAfterMs), [retryAfterMs]);
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
      .unlock(secret, useRecovery)
      .then((result) => {
        setSecret("");
        setBusy(false);
        // Getting in with the recovery key means the password is lost, so the
        // caller is told: the natural next step is setting a new one.
        onUnlocked?.(result);
      })
      .catch((err) => {
        setError(err.message);
        setBusy(false);
        setSecret("");
      });
  };

  return (
    <VaultCard
      icon={useRecovery ? KeyRound : ShieldCheck}
      title="Your vault is locked"
      subtitle={
        useRecovery
          ? "Enter the recovery key you saved when the vault was created."
          : "Enter your master password to see your secure files."
      }
    >
      <input
        type={useRecovery ? "text" : "password"}
        value={secret}
        autoFocus
        onChange={(event) => setSecret(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
        placeholder={useRecovery ? "XXXXX-XXXXX-XXXXX-…" : "Master password"}
        className={`${inputClass} ${useRecovery ? "font-mono" : ""}`}
      />

      <ModalError>{error}</ModalError>

      <ModalButton
        variant="primary"
        onClick={submit}
        busy={busy}
        disabled={waitMs > 0}
        className="mt-4 w-full"
      >
        {waitMs > 0 ? `Try again in ${Math.ceil(waitMs / 1000)}s` : "Unlock"}
      </ModalButton>

      <button
        type="button"
        onClick={() => {
          setUseRecovery((value) => !value);
          setSecret("");
          setError(null);
        }}
        className="mt-3 w-full text-center text-xs text-primary hover:underline"
      >
        {useRecovery
          ? "Use my master password instead"
          : "I forgot my password - use recovery key"}
      </button>
    </VaultCard>
  );
}
