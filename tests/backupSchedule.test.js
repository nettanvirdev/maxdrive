import { describe, expect, it } from "vitest";
import { computeNextRun } from "../src/main/localBackup/schedule.cjs";

const at = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

describe("computeNextRun", () => {
  it("returns null for an empty schedule (manual only)", () => {
    expect(computeNextRun({}, Date.now())).toBeNull();
    expect(computeNextRun("{}", Date.now())).toBeNull();
    expect(computeNextRun(null, Date.now())).toBeNull();
  });

  it("interval adds the minutes to the completion time", () => {
    const from = at(2026, 0, 1, 12, 0);
    expect(computeNextRun({ freq: "interval", intervalMinutes: 90 }, from)).toBe(
      from + 90 * 60_000
    );
  });

  it("daily picks today's slot when still ahead, else tomorrow's", () => {
    const morning = at(2026, 0, 5, 1, 0);
    expect(computeNextRun({ freq: "daily", time: "02:30" }, morning)).toBe(at(2026, 0, 5, 2, 30));
    const evening = at(2026, 0, 5, 23, 0);
    expect(computeNextRun({ freq: "daily", time: "02:30" }, evening)).toBe(at(2026, 0, 6, 2, 30));
  });

  it("weekly lands on the requested weekday", () => {
    // 2026-01-05 is a Monday.
    const monday = at(2026, 0, 5, 12, 0);
    const next = computeNextRun({ freq: "weekly", dayOfWeek: 3, time: "09:00" }, monday);
    const d = new Date(next);
    expect(d.getDay()).toBe(3);
    expect(next).toBe(at(2026, 0, 7, 9, 0));
  });

  it("weekly on the same day rolls a full week once the time has passed", () => {
    const mondayLate = at(2026, 0, 5, 23, 0);
    expect(computeNextRun({ freq: "weekly", dayOfWeek: 1, time: "09:00" }, mondayLate)).toBe(
      at(2026, 0, 12, 9, 0)
    );
  });

  it("monthly clamps day 31 to the month's length", () => {
    const midFeb = at(2026, 1, 10, 12, 0);
    // February 2026 has 28 days.
    expect(computeNextRun({ freq: "monthly", dayOfMonth: 31, time: "03:00" }, midFeb)).toBe(
      at(2026, 1, 28, 3, 0)
    );
  });

  it("monthly rolls into the next month when this month's slot has passed", () => {
    const lateJan = at(2026, 0, 20, 12, 0);
    expect(computeNextRun({ freq: "monthly", dayOfMonth: 15, time: "03:00" }, lateJan)).toBe(
      at(2026, 1, 15, 3, 0)
    );
  });

  it("catch-up semantics: a week asleep produces exactly one next slot", () => {
    // Computing from completion time (now), not from the missed slot, means a
    // laptop that slept through 7 daily runs schedules one future run.
    const wokeUp = at(2026, 0, 12, 14, 0);
    expect(computeNextRun({ freq: "daily", time: "02:00" }, wokeUp)).toBe(at(2026, 0, 13, 2, 0));
  });

  it("accepts the JSON string column form", () => {
    const from = at(2026, 0, 1, 0, 0);
    expect(computeNextRun('{"freq":"daily","time":"05:00"}', from)).toBe(at(2026, 0, 1, 5, 0));
  });
});
