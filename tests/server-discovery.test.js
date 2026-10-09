import { describe, it, expect, vi } from "vitest";

// logger is required at import time; stub it so we don't pull electron-log.
// identity is only used by start()/the socket path, not by the pure helpers.
vi.mock("../src/main/logger.cjs", () => ({
  default: {},
  scope: () => ({ info() {}, warn() {}, error() {} }),
}));

import discovery from "../src/main/server/discovery.cjs";

describe("discovery probe parsing", () => {
  it("accepts a well-formed probe (magic + version ≤ current)", () => {
    const probe = Buffer.concat([Buffer.from("MAXDRV?"), Buffer.from([1])]);
    expect(discovery.isProbe(probe)).toBe(true);
    // version 0 is tolerated too
    expect(
      discovery.isProbe(Buffer.concat([Buffer.from("MAXDRV?"), Buffer.from([0])])),
    ).toBe(true);
  });

  it("rejects wrong magic, short datagrams and future versions", () => {
    expect(discovery.isProbe(Buffer.from("NOPEnope"))).toBe(false);
    expect(discovery.isProbe(Buffer.from("MAXDRV?"))).toBe(false); // missing version byte
    expect(
      discovery.isProbe(Buffer.concat([Buffer.from("MAXDRV?"), Buffer.from([9])])),
    ).toBe(false); // newer than we speak
    expect(discovery.isProbe("not a buffer")).toBe(false);
  });

  it("builds a reply advertising this server", () => {
    const reply = discovery.buildReply({
      apiPort: 47821,
      version: "1.2.3",
      serverId: "server-guid-123",
    });
    expect(reply).toMatchObject({
      magic: "MAXDRV!",
      app: "MaxDrive",
      apiPort: 47821,
      appVersion: "1.2.3",
      serverId: "server-guid-123",
    });
    expect(reply.version).toBe(1); // protocol version
    expect(typeof reply.name).toBe("string");
  });
});
