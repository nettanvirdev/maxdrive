import { useState } from "react";
import { Database } from "lucide-react";
import {
  Modal,
  ModalButton,
  ModalError,
  inputClass,
} from "@/components/ui/Modal";
import { toast } from "@/stores/useToastStore";
import { accountName, s3Location } from "@/lib/accounts";

const GB = 1024 ** 3;

/**
 * Add or edit an S3-compatible bucket (AWS, Cloudflare R2, MinIO, Backblaze…).
 * `account` is the row being edited, or null to add one.
 *
 * Where the bucket lives is fixed once connected - changing it would orphan
 * every indexed file - so edit mode shows it read-only and only lets the name,
 * the limit and the keys change. Main tests the connection either way; its
 * error message is what the user sees.
 */
export function S3AccountDialog({ account, onClose }) {
  const editing = Boolean(account);
  const config = account?.config || {};

  const [label, setLabel] = useState(account?.display_name || "");
  const [endpoint, setEndpoint] = useState(config.endpoint || "");
  const [region, setRegion] = useState(config.region || "us-east-1");
  const [bucket, setBucket] = useState(config.bucket || "");
  const [prefix, setPrefix] = useState(config.prefix || "");
  // Follows the endpoint until the user flips it: MinIO and most self-hosted
  // servers need path-style, AWS and R2 work either way.
  const [pathStyle, setPathStyle] = useState(
    editing ? Boolean(config.pathStyle) : null,
  );
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [limitGb, setLimitGb] = useState(
    account?.quota_limit ? String(+(account.quota_limit / GB).toFixed(2)) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const effectivePathStyle = pathStyle ?? Boolean(endpoint.trim());
  const limit = Number(limitGb);
  const keysGiven = Boolean(accessKeyId.trim()) + Boolean(secretAccessKey.trim());
  const valid =
    limit > 0 &&
    (editing
      ? keysGiven !== 1
      : Boolean(bucket.trim() && region.trim()) && keysGiven === 2);

  const submit = async (event) => {
    event?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const keys =
        keysGiven === 2
          ? {
              accessKeyId: accessKeyId.trim(),
              secretAccessKey: secretAccessKey.trim(),
            }
          : {};
      const row = editing
        ? await window.maxdrive.accounts.updateS3(account.id, {
            label: label.trim() || null,
            limitGb: limit,
            ...keys,
          })
        : await window.maxdrive.accounts.connectS3({
            label: label.trim() || null,
            endpoint: endpoint.trim(),
            region: region.trim(),
            bucket: bucket.trim(),
            prefix: prefix.trim(),
            pathStyle: effectivePathStyle,
            limitGb: limit,
            ...keys,
          });
      toast.success(
        editing
          ? `Saved ${accountName(row || account)}`
          : `Connected ${accountName(row) || bucket.trim()}`,
      );
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? "Edit S3 storage" : "Add S3-compatible storage"}
      subtitle={
        editing
          ? s3Location(account)
          : "AWS S3, Cloudflare R2, MinIO, Backblaze B2 and others"
      }
      icon={
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-drive-variant">
          <Database className="h-4 w-4 text-primary" />
        </span>
      }
      width={520}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            busy={busy}
            disabled={!valid}
            onClick={submit}
          >
            {busy
              ? editing
                ? "Saving…"
                : "Testing connection…"
              : editing
                ? "Save"
                : "Connect"}
          </ModalButton>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" hint="Optional - shown instead of the bucket name.">
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={bucket || "My bucket"}
            className={inputClass}
          />
        </Field>

        <Field label="Endpoint URL">
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            readOnly={editing}
            placeholder="https://<account>.r2.cloudflarestorage.com — leave blank for AWS"
            className={readOnly(inputClass, editing)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Bucket">
            <input
              value={bucket}
              onChange={(event) => setBucket(event.target.value)}
              readOnly={editing}
              className={readOnly(inputClass, editing)}
            />
          </Field>
          <Field label="Region" hint='Use "auto" for Cloudflare R2.'>
            <input
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              readOnly={editing}
              className={readOnly(inputClass, editing)}
            />
          </Field>
        </div>

        <Field
          label="Prefix"
          hint="Optional - only use this folder of the bucket."
        >
          <input
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            readOnly={editing}
            placeholder="maxdrive/"
            className={readOnly(inputClass, editing)}
          />
        </Field>

        <label
          className={`flex items-start gap-2.5 rounded-lg border border-border p-3 text-sm text-foreground ${
            editing
              ? "opacity-60"
              : "cursor-pointer transition-colors duration-150 hover:bg-[var(--hover-overlay)]"
          }`}
        >
          <input
            type="checkbox"
            checked={effectivePathStyle}
            disabled={editing}
            onChange={(event) => setPathStyle(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
          />
          <span>
            Path-style URLs
            <span className="mt-0.5 block text-xs text-muted-foreground">
              MinIO and most self-hosted servers need this. AWS and R2 work
              either way.
            </span>
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Access key ID">
            <input
              value={accessKeyId}
              onChange={(event) => setAccessKeyId(event.target.value)}
              placeholder={editing ? "Unchanged" : ""}
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
            />
          </Field>
          <Field label="Secret access key">
            <input
              type="password"
              value={secretAccessKey}
              onChange={(event) => setSecretAccessKey(event.target.value)}
              placeholder={editing ? "Unchanged" : ""}
              autoComplete="off"
              className={inputClass}
            />
          </Field>
        </div>
        {editing ? (
          <p className="-mt-2 text-xs text-muted-foreground">
            Leave both keys blank to keep the current ones; to replace them,
            enter both.
          </p>
        ) : null}

        <Field
          label="Storage limit (GB)"
          hint="MaxDrive never places more than this on the bucket. Buckets have no quota of their own, so this is what upload placement plans around."
        >
          <input
            type="number"
            min="0"
            step="any"
            value={limitGb}
            onChange={(event) => setLimitGb(event.target.value)}
            placeholder="100"
            className={inputClass}
          />
        </Field>

        <ModalError>{error}</ModalError>
        {/* Enter submits even though the button lives in the footer. */}
        <button
          type="submit"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
      </form>
    </Modal>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-drive-tertiary">{hint}</span>
      ) : null}
    </label>
  );
}

const readOnly = (cls, on) =>
  on ? `${cls} cursor-default opacity-70 focus:border-border focus:ring-0` : cls;
