import { describe, expect, it } from "vitest";
import { plan, removalImpact } from "../src/main/vault/planner.cjs";

const file = (id, size = 100) => ({ id, is_folder: 0, blob_size: size });
const copy = (itemId, accountId, state = "ok") => ({
  item_id: itemId,
  account_id: accountId,
  state,
});
const acct = (accountId, extra = {}) => ({
  accountId,
  state: "active",
  health: "ok",
  freeBytes: 1_000_000,
  ...extra,
});

describe("replication planning", () => {
  it("places a brand-new file", () => {
    const actions = plan({ items: [file("a")], copies: [], accounts: [acct("x")] });
    expect(actions).toEqual([
      { type: "replicate", itemId: "a", toAccountId: "x", fromAccountId: null, size: 100 },
    ]);
  });

  it("does nothing when the desired count is already met", () => {
    expect(
      plan({ items: [file("a")], copies: [copy("a", "x")], accounts: [acct("x")] })
    ).toEqual([]);
  });

  it("adds a second copy when the desired count rises", () => {
    const actions = plan({
      items: [file("a")],
      copies: [copy("a", "x")],
      accounts: [acct("x"), acct("y")],
      desiredCopies: 2,
    });
    expect(actions).toEqual([
      { type: "replicate", itemId: "a", toAccountId: "y", fromAccountId: "x", size: 100 },
    ]);
  });

  it("copies from an existing holder rather than nowhere", () => {
    const [action] = plan({
      items: [file("a")],
      copies: [copy("a", "x")],
      accounts: [acct("x"), acct("y")],
      desiredCopies: 2,
    });
    expect(action.fromAccountId).toBe("x");
  });

  it("never targets the account that already holds a copy", () => {
    const actions = plan({
      items: [file("a")],
      copies: [copy("a", "x")],
      accounts: [acct("x"), acct("y"), acct("z")],
      desiredCopies: 3,
    });
    expect(actions.map((a) => a.toAccountId).sort()).toEqual(["y", "z"]);
  });

  it("prefers the account with the most room", () => {
    const [action] = plan({
      items: [file("a")],
      accounts: [acct("small", { freeBytes: 500 }), acct("big", { freeBytes: 900_000 })],
    });
    expect(action.toAccountId).toBe("big");
  });

  it("does not promise the same free space twice", () => {
    const actions = plan({
      items: [file("a", 400), file("b", 400)],
      accounts: [acct("only", { freeBytes: 500 })],
    });
    expect(actions[0]).toMatchObject({ type: "replicate", itemId: "a" });
    expect(actions[1]).toMatchObject({ type: "blocked", itemId: "b", reason: "quota" });
  });

  it("reports a quota block when nothing has room", () => {
    const actions = plan({
      items: [file("a", 5000)],
      accounts: [acct("x", { freeBytes: 10 })],
    });
    expect(actions).toEqual([{ type: "blocked", itemId: "a", reason: "quota" }]);
  });

  it("reports no-target when there are no usable accounts", () => {
    const actions = plan({ items: [file("a")], accounts: [acct("x", { health: "error" })] });
    expect(actions).toEqual([{ type: "blocked", itemId: "a", reason: "no-target" }]);
  });

  it("counts in-flight uploads as coverage", () => {
    expect(
      plan({
        items: [file("a")],
        copies: [copy("a", "x", "uploading")],
        accounts: [acct("x"), acct("y")],
      })
    ).toEqual([]);
  });

  it("ignores failed copies when counting coverage", () => {
    const actions = plan({
      items: [file("a")],
      copies: [copy("a", "x", "failed")],
      accounts: [acct("x"), acct("y")],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("replicate");
  });

  it("skips folders", () => {
    expect(
      plan({ items: [{ id: "f", is_folder: 1 }], accounts: [acct("x")] })
    ).toEqual([]);
  });
});

describe("unavailable accounts", () => {
  it("keeps an unhealthy account's copies as coverage", () => {
    expect(
      plan({
        items: [file("a")],
        copies: [copy("a", "x")],
        accounts: [acct("x", { health: "error" }), acct("y")],
      })
    ).toEqual([]);
  });

  it("does not send new copies to an unhealthy account", () => {
    const actions = plan({
      items: [file("a")],
      accounts: [acct("bad", { health: "error" }), acct("good")],
    });
    expect(actions[0].toAccountId).toBe("good");
  });
});

describe("draining and surplus", () => {
  it("moves a draining account's file to a keeper", () => {
    const actions = plan({
      items: [file("a")],
      copies: [copy("a", "old")],
      accounts: [acct("old", { state: "draining" }), acct("new")],
    });
    expect(actions).toContainEqual({
      type: "replicate", itemId: "a", toAccountId: "new", fromAccountId: "old", size: 100,
    });
  });

  it("signals drain completion only when nothing is left", () => {
    const withFiles = plan({
      items: [file("a")],
      copies: [copy("a", "old")],
      accounts: [acct("old", { state: "draining" }), acct("new")],
    });
    expect(withFiles.some((a) => a.type === "drainComplete")).toBe(false);

    const empty = plan({
      items: [file("a")],
      copies: [copy("a", "new")],
      accounts: [acct("old", { state: "draining" }), acct("new")],
    });
    expect(empty).toContainEqual({ type: "drainComplete", accountId: "old" });
  });

  it("trims surplus copies when the desired count drops", () => {
    const actions = plan({
      items: [file("a")],
      copies: [copy("a", "x"), copy("a", "y")],
      accounts: [acct("x", { freeBytes: 900_000 }), acct("y", { freeBytes: 100 })],
      desiredCopies: 1,
    });
    // The tightest account gives up its copy first.
    expect(actions).toEqual([{ type: "deleteCopy", itemId: "a", accountId: "y" }]);
  });

  it("never deletes the last copy", () => {
    const actions = plan({
      items: [file("a")],
      copies: [copy("a", "x")],
      accounts: [acct("x")],
      desiredCopies: 1,
    });
    expect(actions.some((a) => a.type === "deleteCopy")).toBe(false);
  });

  it("does not trim while a replacement is still uploading", () => {
    const actions = plan({
      items: [file("a")],
      copies: [copy("a", "x"), copy("a", "y", "uploading")],
      accounts: [acct("x"), acct("y")],
      desiredCopies: 1,
    });
    expect(actions.some((a) => a.type === "deleteCopy")).toBe(false);
  });
});

describe("removalImpact", () => {
  it("finds files that would lose their only copy", () => {
    const impact = removalImpact({
      items: [file("a"), file("b")],
      copies: [copy("a", "x"), copy("b", "x"), copy("b", "y")],
      accountId: "x",
    });
    expect(impact.soleItems.map((i) => i.id)).toEqual(["a"]);
    expect(impact.totalHere).toBe(2);
  });

  it("is empty when everything is replicated elsewhere", () => {
    const impact = removalImpact({
      items: [file("a")],
      copies: [copy("a", "x"), copy("a", "y")],
      accountId: "x",
    });
    expect(impact.soleItems).toEqual([]);
  });

  it("ignores copies that are not confirmed", () => {
    const impact = removalImpact({
      items: [file("a")],
      copies: [copy("a", "x"), copy("a", "y", "uploading")],
      accountId: "x",
    });
    expect(impact.soleItems.map((i) => i.id)).toEqual(["a"]);
  });
});
