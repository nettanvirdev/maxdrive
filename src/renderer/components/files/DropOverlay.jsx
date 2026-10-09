import { Upload } from "lucide-react";

/** Shown while files are dragged over a drop zone, naming the destination. */
export function DropOverlay({ title, hint, icon: Icon = Upload }) {
  return (
    <div className="pointer-events-none absolute inset-4 z-30 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary bg-[var(--selected-overlay)] backdrop-blur-[1px]">
      <Icon className="h-10 w-10 text-primary" />
      <p className="text-base font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
