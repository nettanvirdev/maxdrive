import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal, ModalButton, ModalError } from "./Modal";

/**
 * Replaces window.confirm.
 *
 * Chromium's own confirm box is a grey OS-styled sheet with an "Untitled" title
 * bar, which in a frameless themed app looks like a different program has taken
 * over - and it blocks the whole renderer while it is up.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      width={440}
      onClose={onClose}
      icon={
        danger ? (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-drive-variant">
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </span>
        ) : null
      }
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton
            variant={danger ? "danger" : "primary"}
            busy={busy}
            onClick={confirm}
            data-autofocus
          >
            {confirmLabel}
          </ModalButton>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{message}</p>
      <ModalError>{error}</ModalError>
    </Modal>
  );
}
