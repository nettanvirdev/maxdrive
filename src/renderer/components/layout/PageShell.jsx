/**
 * The white surface every page renders into.
 *
 * The title row is fixed and only `children` scrolls. When the whole surface
 * scrolled, the first row of content slid up into the rounded top corners and
 * sat flush against the edge - the page looked broken at any scroll position
 * other than zero. Keeping the chrome still also means the view toggle and the
 * selection actions never scroll out of reach.
 */
export function PageShell({ title, actions, children }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-8 pb-4 pt-7">
        <div className="min-w-0 flex-1">
          {typeof title === "string" ? (
            <h1 className="truncate text-[22px] font-normal leading-7 text-foreground">
              {title}
            </h1>
          ) : (
            title
          )}
        </div>
        {actions}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">{children}</div>
    </div>
  );
}
