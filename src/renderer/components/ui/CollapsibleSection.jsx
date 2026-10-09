import { useState } from "react";
import { ChevronDown } from "lucide-react";

/** Drive's collapsible section header: a chevron that rotates, plus optional right-side controls. */
export function CollapsibleSection({ title, children, actions, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm font-medium text-foreground transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)]"
        >
          <ChevronDown
            className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ease-standard ${
              open ? "" : "-rotate-90"
            }`}
          />
          {title}
        </button>
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
      {open ? <div className="animate-fade-in">{children}</div> : null}
    </section>
  );
}
