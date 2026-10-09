import { Grid2x2, List } from "lucide-react";

/** design.json view_mode_toggle: 36px pill, 2px inset, active item on the accent pill. */
export function ViewModeToggle({ value, onChange }) {
  return (
    <div className="flex h-9 items-center gap-0.5 rounded-full border border-border bg-card p-0.5">
      <Item active={value === "list"} onClick={() => onChange("list")} label="List view">
        <List className="h-4 w-4" />
      </Item>
      <Item active={value === "grid"} onClick={() => onChange("grid")} label="Grid view">
        <Grid2x2 className="h-4 w-4" />
      </Item>
    </div>
  );
}

function Item({ children, active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-8 w-9 items-center justify-center rounded-full transition-colors duration-150 ease-standard ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-[var(--hover-overlay)]"
      }`}
    >
      {children}
    </button>
  );
}
