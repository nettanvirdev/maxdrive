/** The bordered settings group, its label/hint row, and the switch row. */
export function Group({ title, children }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-medium text-foreground">{title}</h2>
      <div className="divide-y divide-border rounded-lg border border-border">
        {children}
      </div>
    </section>
  );
}

export function Row({ label, hint, children }) {
  return (
    <div className="flex items-center gap-6 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function Toggle({ label, hint, checked, onChange, disabled }) {
  return (
    <Row label={label} hint={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ease-standard disabled:opacity-50 ${
          checked ? "bg-primary" : "bg-drive-variant border border-border"
        }`}
      >
        {/* left-0 anchors the knob; without it the static position puts the
            "on" state entirely outside the pill. */}
        <span
          className={`absolute left-0 top-0.5 h-5 w-5 rounded-full shadow-gcard transition-transform duration-200 ease-standard ${
            checked
              ? "translate-x-[22px] bg-[var(--primary-foreground)]"
              : "translate-x-0.5 bg-card"
          }`}
        />
      </button>
    </Row>
  );
}
