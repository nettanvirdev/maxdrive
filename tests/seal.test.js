import { describe, it, expect, beforeEach } from "vitest";

import { COMMAND_MAP, isAvailable } from "@/commands/registry";
import { runCommand } from "@/commands/dispatch";
import { useOverlayStore } from "@/stores/useOverlayStore";

/** Vault mode ("seal") gating in the command registry. */
const ctxFor = (node, extra = {}) => ({
  view: "browse",
  list: [node],
  nodes: [node],
  node,
  hasSelection: true,
  inTrash: false,
  transfers: [],
  ...extra,
});

const driveFile = {
  id: "g:a:1",
  name: "a.txt",
  is_folder: false,
  account_id: "a",
  account_provider: "gdrive",
  drive_file_id: "1",
  web_view_link: "https://drive.google.com/x",
};
const available = (id, ctx) => isAvailable(COMMAND_MAP.get(id), ctx);

describe("vault mode commands", () => {
  beforeEach(() => useOverlayStore.getState().closeAll());

  it("never offers sharing or Drive links for a sealed file, locked or not", () => {
    for (const sealLocked of [true, false]) {
      const ctx = ctxFor({ ...driveFile, sealed: true, sealLocked });
      expect(available("file.share", ctx)).toBe(false);
      expect(available("file.createLink", ctx)).toBe(false);
      expect(available("file.openExternal", ctx)).toBe(false);
    }
    expect(available("file.share", ctxFor(driveFile))).toBe(true);
  });

  it("opens the unlock dialog instead of acting on a locked sealed file", async () => {
    const node = { ...driveFile, sealed: true, sealLocked: true };
    for (const id of ["file.open", "file.preview", "file.rename", "file.download"]) {
      useOverlayStore.getState().closeAll();
      await runCommand(id, ctxFor(node));
      expect(useOverlayStore.getState().dialog?.kind).toBe("sealUnlock");
      expect(useOverlayStore.getState().preview).toBeNull();
    }
  });

  it("acts normally on an unlocked sealed file", async () => {
    const node = { ...driveFile, sealed: true, sealLocked: false };
    await runCommand("file.rename", ctxFor(node));
    expect(useOverlayStore.getState().dialog?.kind).toBe("rename");
  });

  it("hides plain uploads on the Secure view", () => {
    const ctx = ctxFor(driveFile, { view: "secure" });
    expect(available("file.upload", ctx)).toBe(false);
    expect(available("file.uploadFolder", ctx)).toBe(false);
    expect(available("file.upload", ctxFor(driveFile))).toBe(true);
  });

  it("offers unlock only when configured and locked, lock only when unlocked", () => {
    const locked = { seal: { configured: true, unlocked: false } };
    const open = { seal: { configured: true, unlocked: true } };
    expect(available("seal.unlock", locked)).toBe(true);
    expect(available("seal.lock", locked)).toBe(false);
    expect(available("seal.unlock", open)).toBe(false);
    expect(available("seal.lock", open)).toBe(true);
    expect(available("seal.unlock", { seal: null })).toBe(false);
  });
});
