/**
 * Schedule arithmetic for backup sets. Pure module - the tick loop lives in
 * index.cjs; this only answers "given this schedule, when is the next run?"
 *
 * Schedule shape (JSON on backup_sets.schedule):
 *   { freq: 'daily'|'weekly'|'monthly'|'interval',
 *     time: 'HH:MM',            // daily/weekly/monthly, local time
 *     dayOfWeek: 0-6,           // weekly (0 = Sunday)
 *     dayOfMonth: 1-31,         // monthly, clamped to the month's length
 *     intervalMinutes: number } // interval
 *
 * An empty/invalid schedule returns null: the set runs manually only.
 */

function parseSchedule(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function parseTime(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
  if (!match) return [2, 0]; // default 02:00 - a quiet hour
  const h = Math.min(23, Math.max(0, Number(match[1])));
  const m = Math.min(59, Math.max(0, Number(match[2])));
  return [h, m];
}

function monthlyAt(year, month, dayOfMonth, h, m) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return new Date(
    year,
    month,
    Math.min(dayOfMonth, daysInMonth),
    h,
    m,
    0,
    0,
  ).getTime();
}

/**
 * @param {object|string} rawSchedule
 * @param {number} fromMs compute the first occurrence strictly after this time.
 *   Callers pass run-completion time, so a laptop asleep for a week catches up
 *   with ONE run, not seven.
 * @returns {number|null} epoch ms of the next run, or null for manual-only
 */
function computeNextRun(rawSchedule, fromMs) {
  const s = parseSchedule(rawSchedule);
  if (!s.freq) return null;

  if (s.freq === "interval") {
    const minutes = Number(s.intervalMinutes);
    return fromMs + (minutes > 0 ? minutes : 360) * 60_000;
  }

  const [h, m] = parseTime(s.time);
  const from = new Date(fromMs);

  if (s.freq === "daily") {
    const next = new Date(fromMs);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (s.freq === "weekly") {
    const dow = Number.isInteger(s.dayOfWeek) ? ((s.dayOfWeek % 7) + 7) % 7 : 0;
    const next = new Date(fromMs);
    next.setHours(h, m, 0, 0);
    let delta = (dow - next.getDay() + 7) % 7;
    if (delta === 0 && next.getTime() <= fromMs) delta = 7;
    next.setDate(next.getDate() + delta);
    return next.getTime();
  }

  if (s.freq === "monthly") {
    const dom = Math.min(31, Math.max(1, Number(s.dayOfMonth) || 1));
    let next = monthlyAt(from.getFullYear(), from.getMonth(), dom, h, m);
    if (next <= fromMs)
      next = monthlyAt(from.getFullYear(), from.getMonth() + 1, dom, h, m);
    return next;
  }

  return null;
}

module.exports = { computeNextRun };
