import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A dropdown that renders into document.body.
 *
 * Portalling is not cosmetic here: file rows live inside two nested
 * `overflow: auto` containers, and an absolutely positioned menu would be
 * clipped by both. Coordinates are viewport-relative and flipped when the menu
 * would run off the bottom or right edge.
 */
export function Menu({ x, y, onClose, width = 252, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  // Measure after paint so the flip decision uses the real height, which
  // changes when the menu drills into a submenu page.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y;
    setPos({ left, top });
  }, [x, y, children]);

  useEffect(() => {
    const onDown = (event) => {
      if (!ref.current?.contains(event.target)) onClose(event);
    };
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    // Capture phase: a row's own click handler must not re-open what this closes.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    // Scrolling the list would leave the menu floating away from its row.
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        width,
        // Hidden for the single frame between mount and measurement.
        visibility: pos ? "visible" : "hidden",
      }}
      className="fixed z-[60] animate-fade-in overflow-hidden rounded-lg border border-border bg-popover py-2 shadow-gdrop"
    >
      {children}
    </div>,
    document.body
  );
}

export function MenuItem({ icon: Icon, label, hint, onClick, danger, disabled }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 w-full items-center gap-3 px-4 text-left text-sm transition-colors duration-150 ease-standard disabled:opacity-40 ${
        danger
          ? "text-destructive hover:bg-[var(--hover-overlay)]"
          : "text-foreground hover:bg-[var(--hover-overlay)]"
      }`}
    >
      {Icon ? (
        <Icon className={`h-4 w-4 shrink-0 ${danger ? "" : "text-muted-foreground"}`} />
      ) : (
        <span className="w-4" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-xs text-muted-foreground">{hint}</span> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 border-t border-border" />;
}

export function MenuHeader({ children }) {
  return (
    <p className="px-4 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">{children}</p>
  );
}
