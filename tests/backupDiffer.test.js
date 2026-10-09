import { describe, expect, it } from "vitest";
import { diff, deletionsHeld } from "../src/main/localBackup/differ.cjs";

const entry = (relPath, over = {}) => ({
  rel_path: relPath,
  size: 100,
  mtime: 1_000_000,
  md5: "abc",
  account_id: "acct",
  drive_file_id: "file-1",
  state: "ok",
  ...over,
});

const disk = (pairs) => new Map(pairs);

describe("diff", () => {
  it("classifies new files as uploads with op new", () => {
    const d = diff(disk([["a.txt", { size: 5, mtime: 1 }]]), []);
    expect(d.uploads).toEqual([{ relPath: "a.txt", size: 5, mtime: 1, op: "new", fileId: null }]);
    expect(d.deletions).toEqual([]);
  });

  it("leaves unchanged files alone", () => {
    const d = diff(disk([["a.txt", { size: 100, mtime: 1_000_000 }]]), [entry("a.txt")]);
    expect(d.uploads).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("tolerates sub-2s mtime jitter (FAT granularity)", () => {
    const d = diff(disk([["a.txt", { size: 100, mtime: 1_001_500 }]]), [entry("a.txt")]);
    expect(d.uploads).toEqual([]);
  });

  it("flags a changed file as an update keeping its Drive identity", () => {
    const d = diff(disk([["a.txt", { size: 120, mtime: 2_000_000 }]]), [entry("a.txt")]);
    expect(d.uploads[0]).toMatchObject({ op: "update", fileId: "file-1" });
  });

  it("propagates deletions only for entries that reached the cloud", () => {
    const d = diff(disk([]), [
      entry("uploaded.txt"),
      entry("never-made-it.txt", { drive_file_id: null, state: "pending" }),
    ]);
    expect(d.deletions.map((e) => e.rel_path)).toEqual(["uploaded.txt"]);
    expect(d.forgets.map((e) => e.rel_path)).toEqual(["never-made-it.txt"]);
  });

  it("ignores entries whose deletion was already applied", () => {
    const d = diff(disk([]), [
      entry("gone.txt", { state: "trashed" }),
      entry("kept.txt", { state: "deleted_local" }),
    ]);
    expect(d.deletions).toEqual([]);
  });

  it("re-adds a previously trashed file as a fresh upload", () => {
    const d = diff(disk([["gone.txt", { size: 50, mtime: 9 }]]), [
      entry("gone.txt", { state: "trashed" }),
    ]);
    expect(d.uploads[0]).toMatchObject({ op: "new", relPath: "gone.txt" });
  });

  it("proposes a rename for a unique size+mtime pair", () => {
    const d = diff(disk([["renamed.txt", { size: 100, mtime: 1_000_000 }]]), [entry("old.txt")]);
    expect(d.renameCandidates).toHaveLength(1);
    expect(d.renameCandidates[0].from.rel_path).toBe("old.txt");
    expect(d.renameCandidates[0].to.relPath).toBe("renamed.txt");
  });

  it("degrades ambiguous rename pairs to delete+upload", () => {
    const d = diff(
      disk([
        ["x1.txt", { size: 100, mtime: 1_000_000 }],
        ["x2.txt", { size: 100, mtime: 1_000_000 }],
      ]),
      [entry("a.txt"), entry("b.txt", { drive_file_id: "file-2" })]
    );
    expect(d.renameCandidates).toEqual([]);
    expect(d.uploads).toHaveLength(2);
    expect(d.deletions).toHaveLength(2);
  });

  it("never pairs empty files (they all look identical)", () => {
    const d = diff(disk([["b.txt", { size: 0, mtime: 1_000_000 }]]), [
      entry("a.txt", { size: 0 }),
    ]);
    expect(d.renameCandidates).toEqual([]);
  });

  it("re-queues error/skipped entries as uploads", () => {
    const d = diff(disk([["a.txt", { size: 100, mtime: 1_000_000 }]]), [
      entry("a.txt", { state: "error" }),
    ]);
    expect(d.uploads[0]).toMatchObject({ op: "update", fileId: "file-1" });
  });
});

describe("deletionsHeld (mass-delete guard)", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => entry(`f${i}`));

  it("small deletion counts pass through", () => {
    expect(deletionsHeld(many(20), 40)).toBe(false);
  });

  it("holds when both thresholds trip", () => {
    expect(deletionsHeld(many(30), 40)).toBe(true);
  });

  it("large but proportionally small deletions pass", () => {
    expect(deletionsHeld(many(30), 1000)).toBe(false);
  });
});
