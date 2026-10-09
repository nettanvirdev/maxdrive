const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Drive-style size: 3 significant digits, no trailing ".0". */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes === 0) return "0 B";
  const exponent = Math.min(
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
    UNITS.length - 1
  );
  const value = bytes / 1024 ** exponent;
  const decimals = value >= 100 || exponent === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${UNITS[exponent]}`;
}

/** "1.2 MB/s". Below a hundred bytes a second it is noise, so it reads "—". */
export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond < 100) return null;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Rough time remaining, rounded the way a progress dialog should round. */
export function formatEta(bytesRemaining, bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond < 100 || bytesRemaining <= 0) return null;
  const seconds = Math.round(bytesRemaining / bytesPerSecond);
  if (seconds < 10) return "a few seconds left";
  if (seconds < 60) return `${Math.round(seconds / 5) * 5} seconds left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} left`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} left`;
}

export function formatDate(ms) {
  if (!ms) return "—";
  const date = new Date(ms);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Drive-style: "5:08 PM" today, "Jun 20" earlier. */
export function formatWhen(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : formatDate(ms);
}

const ACTIVITY_VERBS = {
  uploaded: "You uploaded",
  created: "You created",
  renamed: "You renamed",
  moved: "You moved",
  trashed: "You deleted",
  restored: "You restored",
  downloaded: "You downloaded",
  shared: "You shared",
  migrated: "You moved accounts",
};

/**
 * The Activity column. Our own operations are logged precisely ("You uploaded ·
 * 5:08 PM"); files that only exist because the scanner found them fall back to
 * Drive's own timestamps ("Modified · Jun 20").
 */
export function describeActivity(file) {
  if (file?.last_activity) {
    const [kind, at] = file.last_activity.split("\t");
    const verb = ACTIVITY_VERBS[kind] || kind;
    return `${verb} · ${formatWhen(Number(at))}`;
  }
  if (!file?.modified_at && !file?.created_at) return "—";
  // A minute of slack separates "genuinely edited later" from upload jitter.
  if (file.modified_at && file.modified_at - (file.created_at ?? 0) > 60_000) {
    return `Modified · ${formatWhen(file.modified_at)}`;
  }
  return `Created · ${formatWhen(file.created_at ?? file.modified_at)}`;
}

export function formatRelative(ms) {
  if (!ms) return "never";
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
