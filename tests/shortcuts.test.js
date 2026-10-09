import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  chordFromEvent,
  formatChord,
  isBareKey,
  isTextEntry,
  isUnsafeWhileTyping,
  normaliseChord,
} from "@/shortcuts/keys";
import { DEFAULT_BINDINGS } from "@/shortcuts/defaults";
import {
  findConflicts,
  resolveBindings,
  wouldConflict,
} from "@/shortcuts/useShortcutStore";
import { COMMANDS, COMMAND_MAP, isAvailable } from "@/commands/registry";
import { resolveChord } from "@/commands/dispatch";
import { fuzzyScore, rankCommands } from "@/components/command/CommandPalette";
import { useSelectionStore } from "@/stores/useSelectionStore";
import { useOverlayStore } from "@/stores/useOverlayStore";

/** A keyboard event stand-in; only the fields chordFromEvent reads. */
const keyEvent = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("chord parsing", () => {
  it("orders modifiers canonically regardless of how they were written", () => {
    expect(normaliseChord("Shift+Mod+N")).toBe("mod+shift+n");
    expect(normaliseChord("mod+shift+n")).toBe("mod+shift+n");
    expect(normaliseChord("ALT+Left")).toBe("alt+left");
  });

  it("normalises key aliases so Esc and Escape are one chord", () => {
    expect(normaliseChord("Esc")).toBe("escape");
    expect(normaliseChord("Del")).toBe("delete");
    expect(normaliseChord("ArrowUp")).toBe("up");
  });

  it("builds a chord from an event", () => {
    expect(chordFromEvent(keyEvent("u", { ctrlKey: true }))).toBe("mod+u");
    expect(
      chordFromEvent(keyEvent("N", { ctrlKey: true, shiftKey: true })),
    ).toBe("mod+shift+n");
    expect(chordFromEvent(keyEvent("F2"))).toBe("f2");
  });

  it("ignores a modifier pressed on its own", () => {
    expect(chordFromEvent(keyEvent("Control", { ctrlKey: true }))).toBe("");
    expect(chordFromEvent(keyEvent("Shift", { shiftKey: true }))).toBe("");
  });

  it("identifies bare keys", () => {
    expect(isBareKey("f2")).toBe(true);
    expect(isBareKey("delete")).toBe(true);
    expect(isBareKey("mod+u")).toBe(false);
  });

  it("blocks bare printable keys while typing but never Escape or F-keys", () => {
    // Claiming these mid-typing would make text entry impossible.
    expect(isUnsafeWhileTyping("delete")).toBe(true);
    expect(isUnsafeWhileTyping("space")).toBe(true);
    expect(isUnsafeWhileTyping("r")).toBe(true);

    // A text field can never receive these as input, and Escape must keep
    // working inside the palette's search box and rename fields.
    expect(isUnsafeWhileTyping("escape")).toBe(false);
    expect(isUnsafeWhileTyping("f2")).toBe(false);

    // Modified chords are governed by allowInInput, not by this rule.
    expect(isUnsafeWhileTyping("mod+a")).toBe(false);
  });

  it("formats chords for display", () => {
    expect(formatChord("mod+shift+n")).toBe("Ctrl + Shift + N");
    expect(formatChord("f2")).toBe("F2");
    expect(formatChord("alt+left")).toBe("Alt + ←");
  });
});

describe("platform modifiers", () => {
  it("maps the primary accelerator to Ctrl on Windows", () => {
    // navigator.platform is jsdom's default (not Mac), so `mod` is Ctrl and a
    // bare Meta press must NOT count as the accelerator.
    expect(chordFromEvent(keyEvent("k", { ctrlKey: true }))).toBe("mod+k");
    expect(chordFromEvent(keyEvent("k", { metaKey: true }))).toBe("k");
  });
});

describe("text entry detection", () => {
  const mount = (html) => {
    document.body.innerHTML = html;
    return document.body.firstElementChild;
  };

  it("treats text inputs, textareas and contenteditable as typing", () => {
    expect(isTextEntry(mount('<input type="text" />'))).toBe(true);
    expect(isTextEntry(mount("<textarea></textarea>"))).toBe(true);
    const editable = mount('<div contenteditable="true"></div>');
    expect(isTextEntry(editable)).toBe(true);
  });

  it("does not treat checkboxes or buttons as typing", () => {
    expect(isTextEntry(mount('<input type="checkbox" />'))).toBe(false);
    expect(isTextEntry(mount("<button></button>"))).toBe(false);
  });

  it("detects typing from a node inside a text field", () => {
    const wrapper = mount('<div contenteditable="true"><span>x</span></div>');
    expect(isTextEntry(wrapper.querySelector("span"))).toBe(true);
  });
});

describe("default bindings", () => {
  it("only binds commands that exist", () => {
    for (const binding of DEFAULT_BINDINGS) {
      expect(
        COMMAND_MAP.has(binding.command),
        `unknown command ${binding.command}`,
      ).toBe(true);
    }
  });

  it("ships no hard conflicts - every shared chord is context-gated", () => {
    const hard = findConflicts(DEFAULT_BINDINGS).filter(
      (conflict) => conflict.hard,
    );
    expect(hard, JSON.stringify(hard)).toHaveLength(0);
  });

  it("deliberately shares Space and Delete between contexts", () => {
    const shared = findConflicts(DEFAULT_BINDINGS).map(
      (conflict) => conflict.chord,
    );
    expect(shared).toContain("space");
    expect(shared).toContain("delete");
  });
});

describe("overrides", () => {
  it("replaces a default chord", () => {
    const bindings = resolveBindings({ "file.upload": "mod+shift+u" });
    const upload = bindings.find(
      (binding) => binding.command === "file.upload",
    );
    expect(upload.chord).toBe("mod+shift+u");
  });

  it("unbinds a command when the override is null", () => {
    const bindings = resolveBindings({ "file.upload": null });
    expect(bindings.some((binding) => binding.command === "file.upload")).toBe(
      false,
    );
  });

  it("leaves other commands on their defaults", () => {
    const bindings = resolveBindings({ "file.upload": "mod+shift+u" });
    const rename = bindings.find(
      (binding) => binding.command === "file.rename",
    );
    expect(rename.chord).toBe("f2");
  });

  it("ignores an override for a command that no longer exists", () => {
    expect(() =>
      resolveBindings({ "file.somethingRemoved": "mod+q" }),
    ).not.toThrow();
  });

  it("reports which commands a proposed chord would shadow", () => {
    const bindings = resolveBindings({});
    expect(wouldConflict(bindings, "file.rename", "mod+u")).toContain(
      "file.upload",
    );
    expect(
      wouldConflict(bindings, "file.rename", "mod+shift+alt+z"),
    ).toHaveLength(0);
  });
});

describe("context-aware dispatch", () => {
  const baseContext = {
    view: "browse",
    inFileView: true,
    inTrash: false,
    list: [],
    nodes: [],
    node: null,
    hasSelection: false,
    transfers: [],
    focusedTransfer: null,
    hasFailedTransfers: false,
    hasActiveTransfers: false,
    clipboard: null,
    overlayOpen: false,
  };

  it("routes Space to preview when a file is focused", () => {
    const file = { id: "1", name: "a.txt", is_folder: false };
    const ctx = {
      ...baseContext,
      node: file,
      nodes: [file],
      hasSelection: true,
    };
    const binding = resolveChord(DEFAULT_BINDINGS, "space", ctx, {
      overlayOpen: false,
    });
    expect(binding.command).toBe("file.preview");
  });

  it("routes Space to the job toggle when a running job is focused", () => {
    const job = { id: "t1", state: "running" };
    const ctx = { ...baseContext, focusedTransfer: job, transfers: [job] };
    const binding = resolveChord(DEFAULT_BINDINGS, "space", ctx, {
      overlayOpen: false,
    });
    expect(binding.command).toBe("job.toggle");
  });

  it("routes Delete to trash for files and to remove for a finished job", () => {
    const file = { id: "1", name: "a.txt", is_folder: false };
    const fileCtx = {
      ...baseContext,
      node: file,
      nodes: [file],
      hasSelection: true,
    };
    expect(
      resolveChord(DEFAULT_BINDINGS, "delete", fileCtx, { overlayOpen: false })
        .command,
    ).toBe("file.trash");

    const job = { id: "t1", state: "done" };
    const jobCtx = { ...baseContext, focusedTransfer: job, transfers: [job] };
    expect(
      resolveChord(DEFAULT_BINDINGS, "delete", jobCtx, { overlayOpen: false })
        .command,
    ).toBe("job.remove");
  });

  it("suppresses page shortcuts while an overlay is open", () => {
    const file = { id: "1", name: "a.txt", is_folder: false };
    const ctx = {
      ...baseContext,
      node: file,
      nodes: [file],
      hasSelection: true,
    };
    expect(
      resolveChord(DEFAULT_BINDINGS, "f2", ctx, { overlayOpen: true }),
    ).toBeNull();
  });

  it("still allows always-scoped shortcuts over an overlay", () => {
    const ctx = { ...baseContext, overlayOpen: true };
    const binding = resolveChord(DEFAULT_BINDINGS, "mod+p", ctx, {
      overlayOpen: true,
    });
    expect(binding.command).toBe("palette.open");
  });

  it("returns nothing when no command is available for the chord", () => {
    // Nothing selected, so rename has nothing to act on.
    expect(
      resolveChord(DEFAULT_BINDINGS, "f2", baseContext, { overlayOpen: false }),
    ).toBeNull();
  });

  it("disables trash in the trash view but enables restore", () => {
    const file = { id: "1", name: "a.txt", trashed: true };
    const ctx = {
      ...baseContext,
      view: "trash",
      inTrash: true,
      node: file,
      nodes: [file],
      hasSelection: true,
    };
    expect(isAvailable(COMMAND_MAP.get("file.trash"), ctx)).toBe(false);
    expect(isAvailable(COMMAND_MAP.get("file.restore"), ctx)).toBe(true);
  });

  it("treats a command whose when() throws as unavailable rather than crashing", () => {
    const broken = {
      id: "x",
      when: () => {
        throw new Error("boom");
      },
    };
    expect(isAvailable(broken, baseContext)).toBe(false);
  });
});

describe("command registry", () => {
  it("has unique ids", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every command a title, category, icon and run", () => {
    for (const command of COMMANDS) {
      expect(command.title, command.id).toBeTruthy();
      expect(command.category, command.id).toBeTruthy();
      expect(command.icon, command.id).toBeTruthy();
      expect(typeof command.run, command.id).toBe("function");
    }
  });
});

describe("command palette search", () => {
  it("matches an acronym-style subsequence", () => {
    expect(fuzzyScore("New folder", "nf")).toBeGreaterThan(-1);
    expect(fuzzyScore("Upload folder", "upfo")).toBeGreaterThan(-1);
    expect(fuzzyScore("Upload files", "zzz")).toBe(-1);
  });

  it("ranks the closer match first", () => {
    const ranked = rankCommands(COMMANDS, "upload f");
    expect(["file.upload", "file.uploadFolder"]).toContain(ranked[0].id);
  });

  it("returns everything for an empty query", () => {
    expect(rankCommands(COMMANDS, "")).toHaveLength(COMMANDS.length);
  });
});

describe("selection store", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  beforeEach(() => {
    useSelectionStore.setState({
      ids: [],
      anchorId: null,
      focusId: null,
      list,
    });
  });

  it("selects a single item, replacing what was there", () => {
    const store = useSelectionStore.getState();
    store.select("a");
    store.select("b");
    expect(useSelectionStore.getState().ids).toEqual(["b"]);
  });

  it("toggles items without disturbing the rest", () => {
    const store = useSelectionStore.getState();
    store.select("a");
    store.toggle("c");
    expect(useSelectionStore.getState().ids).toEqual(["a", "c"]);
    useSelectionStore.getState().toggle("a");
    expect(useSelectionStore.getState().ids).toEqual(["c"]);
  });

  it("selects a range from the anchor in either direction", () => {
    const store = useSelectionStore.getState();
    store.select("b");
    store.selectRange(list, "d");
    expect(useSelectionStore.getState().ids).toEqual(["b", "c", "d"]);

    useSelectionStore.getState().select("c");
    useSelectionStore.getState().selectRange(list, "a");
    expect(useSelectionStore.getState().ids).toEqual(["a", "b", "c"]);
  });

  it("moves focus with arrows and clamps at the ends", () => {
    const store = useSelectionStore.getState();
    store.select("a");
    store.moveFocus(list, 1);
    expect(useSelectionStore.getState().focusId).toBe("b");
    useSelectionStore.getState().moveFocus(list, -1);
    expect(useSelectionStore.getState().focusId).toBe("a");
    useSelectionStore.getState().moveFocus(list, -1);
    expect(useSelectionStore.getState().focusId).toBe("a");
  });

  it("extends the selection when moving with shift held", () => {
    const store = useSelectionStore.getState();
    store.select("a");
    store.moveFocus(list, 1, true);
    expect(useSelectionStore.getState().ids).toEqual(["a", "b"]);
  });

  it("selects everything and clears", () => {
    useSelectionStore.getState().selectAll(list);
    expect(useSelectionStore.getState().ids).toHaveLength(4);
    useSelectionStore.getState().clear();
    expect(useSelectionStore.getState().ids).toEqual([]);
  });

  it("prunes ids that have left the list", () => {
    useSelectionStore.getState().selectAll(list);
    useSelectionStore.getState().prune([{ id: "a" }, { id: "c" }]);
    expect(useSelectionStore.getState().ids).toEqual(["a", "c"]);
  });
});

describe("overlay stack", () => {
  beforeEach(() => {
    useOverlayStore.getState().closeAll();
  });

  it("closes the topmost layer first", () => {
    const store = useOverlayStore.getState();
    store.openDialog("rename", { id: "1" });
    store.openPreview({ id: "1" });

    useOverlayStore.getState().closeTop();
    expect(useOverlayStore.getState().preview).toBeNull();
    expect(useOverlayStore.getState().dialog).not.toBeNull();

    useOverlayStore.getState().closeTop();
    expect(useOverlayStore.getState().dialog).toBeNull();
  });

  it("reports when there was nothing to close", () => {
    expect(useOverlayStore.getState().closeTop()).toBe(false);
  });

  it("does not stack the same layer twice", () => {
    const store = useOverlayStore.getState();
    store.openPalette();
    store.openPalette();
    expect(useOverlayStore.getState().stack).toEqual(["palette"]);
  });
});
