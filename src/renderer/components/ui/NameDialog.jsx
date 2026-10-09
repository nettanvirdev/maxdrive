import { useState } from "react";
import { Modal, ModalButton, ModalError, inputClass } from "./Modal";

/**
 * The single-field name prompt behind Rename, New folder and their vault twins.
 * `onSubmit(trimmedName)` does the work; the dialog closes when it resolves and
 * shows the error when it throws. `selectStem` preselects up to the extension,
 * the way Explorer and Drive both do it. Everything else goes to Modal.
 */
export function NameDialog({
  initial = "",
  placeholder,
  submitLabel,
  selectStem,
  onSubmit,
  children,
  ...modal
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    const next = name.trim();
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
      modal.onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      {...modal}
      footer={
        <>
          <ModalButton onClick={modal.onClose}>Cancel</ModalButton>
          <ModalButton
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            onClick={submit}
          >
            {submitLabel}
          </ModalButton>
        </>
      }
    >
      <form onSubmit={submit}>
        <input
          autoFocus
          value={name}
          placeholder={placeholder}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => {
            // With selectStem a typed name keeps the extension.
            const dot = selectStem ? initial.lastIndexOf(".") : -1;
            event.target.setSelectionRange(
              0,
              dot > 0 ? dot : event.target.value.length,
            );
          }}
          className={inputClass}
        />
        {children}
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
