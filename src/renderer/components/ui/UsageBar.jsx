/** A quota meter. `className` sets the track's height and spacing. */
export function UsageBar({ percent, danger, className }) {
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-drive-variant ${className}`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ease-standard ${
          danger ? "bg-destructive" : "bg-primary"
        }`}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
  );
}
