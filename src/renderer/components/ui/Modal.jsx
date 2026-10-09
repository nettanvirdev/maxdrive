import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Every dialog in the app.
 *
 * It portals into document.body, and that is not a style choice: page wrappers
 * carry `animate-fade-in`, whose keyframes include a transform with fill-mode
 * `both`. A transform makes the element a containing block for
 * `position: fixed` descendants *permanently*, so a dialog rendered inside a
 * page centred itself on the content surface instead of the window - visibly
 * off to the right, and sliding with the scroll.
 *
 * The panel is a flex column so a long body scrolls inside it while the title
 * and the actions stay put; the dialog itself never grows past the viewport.
 */
export function Modal({
  label,
  title,
  icon,
  subtitle,
  footer,
  width = 460,
  onClose,
  children,
}) {
  const panel = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus lands inside the dialog so Tab cycles here and Escape is heard even
  // when the click that opened it came from a menu that has since unmounted.
  useEffect(() => {
    const first = panel.current?.querySelector(
      "input:not([type=checkbox]), textarea, [data-autofocus]",
    );
    (first || panel.current)?.focus?.();
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(0,0,0,0.45)] p-6 animate-scrim-in backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      role="presentation"
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label || (typeof title === "string" ? title : undefined)}
        style={{ width }}
        className="flex max-h-full max-w-full animate-dialog-in flex-col overflow-hidden rounded-xl border border-border bg-card shadow-gdrop outline-none"
      >
        <div className="flex shrink-0 items-start gap-3 px-6 pb-3 pt-5">
          {icon ? <div className="mt-0.5 shrink-0">{icon}</div> : null}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-medium leading-6 text-foreground">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-1">
          {children}
        </div>

        {footer ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** The three button shapes every dialog footer uses. */
export function ModalButton({
  children,
  variant = "text",
  icon: Icon,
  busy,
  className = "",
  ...props
}) {
  const styles = {
    text: "text-primary hover:bg-[var(--hover-overlay)]",
    primary:
      "bg-primary text-primary-foreground hover:shadow-gcard disabled:hover:shadow-none",
    danger:
      "bg-destructive text-white hover:shadow-gcard disabled:hover:shadow-none",
  }[variant];

  return (
    <button
      type="button"
      {...props}
      disabled={busy || props.disabled}
      className={`flex h-9 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-shadow duration-200 ease-standard disabled:opacity-50 ${styles} ${className}`}
    >
      {busy ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
      {children}
    </button>
  );
}

/** A bordered group - the container the dialogs use for lists and detail rows. */
export function ModalSection({ title, children, className = "" }) {
  return (
    <div className="mt-4 first:mt-0">
      {title ? (
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          {title}
        </p>
      ) : null}
      <div
        className={`overflow-hidden rounded-lg border border-border ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/** Inline error line, identical everywhere so failures never look like a bug. */
export function ModalError({ children }) {
  if (!children) return null;
  return (
    <p className="mt-3 rounded-lg border border-destructive px-3 py-2 text-xs text-destructive">
      {children}
    </p>
  );
}

/** The single-line text input shape shared by Rename, Share and New folder. */
export const inputClass =
  "h-11 w-full rounded-lg border border-border bg-background px-3.5 text-sm text-foreground outline-none transition-colors duration-150 ease-standard placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary";
