/**
 * Shared empty state. Deliberately quiet: an icon, a short line saying what is
 * missing, and at most one action.
 */
export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center animate-fade-in">
      {Icon ? (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-drive-variant">
          <Icon className="h-7 w-7 text-muted-foreground" />
        </div>
      ) : null}
      <p className="text-[15px] text-foreground">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
