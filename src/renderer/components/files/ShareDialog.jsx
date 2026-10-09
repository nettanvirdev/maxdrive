import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Globe, Link2, Loader2, Lock, UserPlus, X } from "lucide-react";
import { AccountAvatar } from "./FileIcon";
import { Modal, ModalButton, ModalError, inputClass } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";

const ROLES = [
  { id: "reader", label: "Viewer" },
  { id: "commenter", label: "Commenter" },
  { id: "writer", label: "Editor" },
];

/**
 * Drive-style sharing: people by email, plus the public link toggle.
 * Permissions are read back from Drive rather than cached, so changes made on
 * the web are reflected the moment this opens.
 */
export function ShareDialog({ node, onClose }) {
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("reader");
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setPeople(await window.maxdrive.share.listPermissions(node.id));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [node.id]);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (text) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 2500);
  };

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const add = (event) => {
    event.preventDefault();
    run(async () => {
      await window.maxdrive.share.addPerson(node.id, email.trim(), role, notify);
      setEmail("");
      flash("Access granted");
    });
  };

  const linkPermission = people.find((p) => p.type === "anyone");
  const others = people.filter((p) => p.type !== "anyone");

  const toggleLink = () =>
    run(async () => {
      if (linkPermission) {
        await window.maxdrive.share.revoke(node.id);
        flash("Link turned off");
      } else {
        const { link } = await window.maxdrive.share.createLink(node.id);
        await navigator.clipboard.writeText(link);
        flash("Link created and copied");
      }
    });

  const copyLink = () =>
    run(async () => {
      const { link } = await window.maxdrive.share.createLink(node.id);
      await navigator.clipboard.writeText(link);
      flash("Link copied");
    });

  return (
    <Modal
      title={`Share “${node.name}”`}
      label={`Share ${node.name}`}
      width={520}
      onClose={onClose}
      footer={
        <>
          {notice ? (
            <span className="mr-auto flex items-center gap-1.5 text-xs text-drive-sheets">
              <Check className="h-3.5 w-3.5" />
              {notice}
            </span>
          ) : null}
          {linkPermission ? (
            <ModalButton icon={Copy} onClick={copyLink} busy={busy}>
              Copy link
            </ModalButton>
          ) : null}
          <ModalButton variant="primary" onClick={onClose}>
            Done
          </ModalButton>
        </>
      }
    >
      <form onSubmit={add} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Add people by email"
          className={`${inputClass} min-w-0 flex-1`}
        />
        <Select
          value={role}
          onChange={setRole}
          aria-label="Access level"
          className="h-11 shrink-0"
          options={ROLES.map((r) => ({ value: r.id, label: r.label }))}
        />
        <button
          type="submit"
          disabled={busy || !email.trim()}
          aria-label="Grant access"
          title="Grant access"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-shadow duration-200 ease-standard hover:shadow-gcard disabled:opacity-40 disabled:hover:shadow-none"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UserPlus className="h-4 w-4" />
          )}
        </button>
      </form>

      <label className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={notify}
          onChange={(event) => setNotify(event.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--primary)]"
        />
        Send them an email notification
      </label>

      <p className="mb-2 mt-5 text-xs font-medium text-muted-foreground">
        People with access
      </p>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <AccountAvatar email={node.account_email} photo={node.account_photo} size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">
              {node.account_email || "This account"}
            </p>
            <p className="text-xs text-muted-foreground">Owns the file</p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">Owner</span>
        </div>

        {loading ? (
          <p className="border-t border-border px-3 py-2.5 text-sm text-muted-foreground">
            Checking who else has access…
          </p>
        ) : (
          others.map((person) => (
            <div
              key={person.id}
              className="flex items-center gap-3 border-t border-border px-3 py-2.5"
            >
              <AccountAvatar email={person.email} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">
                  {person.name || person.email}
                </p>
                {person.name ? (
                  <p className="truncate text-xs text-muted-foreground">{person.email}</p>
                ) : null}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {ROLES.find((r) => r.id === person.role)?.label || person.role}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(() => window.maxdrive.share.removePermission(node.id, person.id))
                }
                aria-label={`Remove ${person.email}`}
                title={`Remove ${person.email}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-[var(--hover-overlay)] hover:text-destructive disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      <p className="mb-2 mt-5 text-xs font-medium text-muted-foreground">General access</p>
      <div className="flex items-center gap-3 rounded-lg border border-border p-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-drive-variant ${
            linkPermission ? "text-drive-sheets" : "text-muted-foreground"
          }`}
        >
          {linkPermission ? <Globe className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            {linkPermission ? "Anyone with the link" : "Restricted"}
          </p>
          <p className="text-xs text-muted-foreground">
            {linkPermission
              ? "Anyone on the internet with the link can view"
              : "Only people you add can open this"}
          </p>
        </div>
        <button
          type="button"
          onClick={toggleLink}
          disabled={busy}
          className="flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-xs font-medium text-primary transition-colors duration-150 hover:bg-[var(--hover-overlay)] disabled:opacity-50"
        >
          <Link2 className="h-3.5 w-3.5" />
          {linkPermission ? "Turn off" : "Create link"}
        </button>
      </div>

      <ModalError>{error}</ModalError>
    </Modal>
  );
}
