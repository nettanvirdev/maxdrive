const SIZE = {
  sm: "h-7 w-7",
  md: "h-8 w-8",
  lg: "h-9 w-9",
};

/**
 * The round, icon-only button used in toolbars and list rows. `active` pins the
 * icon to the accent colour (a toggled-on state); `danger` reddens it on hover.
 * Pass children instead of `icon` when the glyph needs its own classes.
 */
export function IconButton({
  icon: Icon,
  label,
  size = "lg",
  danger,
  active,
  children,
  ...rest
}) {
  const tone = active
    ? "text-primary"
    : `text-muted-foreground ${danger ? "hover:text-destructive" : "hover:text-foreground"}`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={`flex ${SIZE[size]} shrink-0 items-center justify-center rounded-full transition-colors duration-150 ease-standard hover:bg-[var(--hover-overlay)] disabled:opacity-40 disabled:hover:bg-transparent ${tone}`}
    >
      {children ?? (
        <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
      )}
    </button>
  );
}
