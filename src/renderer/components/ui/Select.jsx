import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/**
 * Themed replacement for native <select> - the OS popup ignores our palette
 * entirely (a white-on-dark Windows list inside a dark dialog).
 *
 * Same portal reasoning as ui/Menu.jsx: triggers live inside the Modal body's
 * `overflow-y-auto`, so the listbox renders into document.body with
 * viewport-relative coordinates, flipping above the trigger when there is no
 * room below. Focus stays on the trigger the whole time (combobox pattern), so
 * one keydown handler covers open/navigate/commit - and stopping propagation
 * there keeps Escape from also closing the surrounding Modal.
 *
 * Options are `{value, label, hint?}`; values compare as strings so numeric
 * values (day-of-week, minutes) behave exactly like they did with <option>.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className = "",
  disabled,
  "aria-label": ariaLabel,
}) {
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex(
    (o) => String(o.value) === String(value),
  );
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState(null);

  const openList = () => {
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
    setPos(null);
    setOpen(true);
  };

  const commit = (index) => {
    setOpen(false);
    const option = options[index];
    if (option && String(option.value) !== String(value))
      onChange(option.value);
  };

  // Position after paint, once the real list height is known.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const list = listRef.current;
    if (!trigger || !list) return;
    const anchor = trigger.getBoundingClientRect();
    const { height } = list.getBoundingClientRect();
    const width = Math.max(anchor.width, 180);
    const left = Math.max(
      8,
      Math.min(anchor.left, window.innerWidth - width - 8),
    );
    const below = anchor.bottom + 4;
    const top =
      below + height > window.innerHeight - 8
        ? Math.max(8, anchor.top - height - 4)
        : below;
    setPos({ left, top, width });
    list
      .querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (event) => {
      if (
        !listRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      )
        close();
    };
    const onScroll = (event) => {
      // Scrolling inside the listbox itself must not dismiss it.
      if (!listRef.current?.contains(event.target)) close();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const onKeyDown = (event) => {
    if (disabled) return;
    const { key } = event;
    if (!open) {
      if (
        key === "Enter" ||
        key === " " ||
        key === "ArrowDown" ||
        key === "ArrowUp"
      ) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (key === "ArrowDown") {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (key === "Home") {
      event.preventDefault();
      setHighlight(0);
    } else if (key === "End") {
      event.preventDefault();
      setHighlight(options.length - 1);
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      commit(highlight);
    } else if (key === "Tab") {
      setOpen(false);
    }
  };

  // Keep the highlighted row in view as arrows move it.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={`flex h-9 items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 text-left text-sm text-foreground outline-none transition-colors duration-150 ease-standard focus:border-primary disabled:opacity-50 ${className}`}
      >
        <span className={`truncate ${selected ? "" : "text-muted-foreground"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-standard ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open
        ? createPortal(
            <div
              ref={listRef}
              role="listbox"
              aria-label={ariaLabel}
              style={{
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                width: pos?.width,
                visibility: pos ? "visible" : "hidden",
              }}
              className="fixed z-[80] max-h-72 animate-fade-in overflow-y-auto rounded-lg border border-border bg-popover py-1.5 shadow-gdrop"
            >
              {options.map((option, index) => {
                const isSelected = index === selectedIndex;
                const isHighlighted = index === highlight;
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-highlighted={isHighlighted || undefined}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => commit(index)}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors duration-150 ease-standard ${
                      isHighlighted ? "bg-[var(--hover-overlay)]" : ""
                    }`}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {isSelected ? (
                        <Check className="h-4 w-4 text-primary" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.hint ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.hint}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
