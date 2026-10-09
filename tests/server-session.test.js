import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import session from "../src/main/server/pairing/session.cjs";
import pairing from "../src/main/server/pairing/crypto.cjs";

/** Build the proof a well-behaved client sends for a given code+salt. */
function proofFor(code, saltB64) {
  const salt = Buffer.from(saltB64, "base64");
  const secret = pairing.deriveSecret(code, salt);
  return pairing.computeProof(secret, salt).toString("base64");
}

/** submitProof throws synchronously on validation failure, or returns a promise. */
function attempt(args) {
  try {
    return { promise: session.submitProof(args) };
  } catch (error) {
    return { error };
  }
}

describe("pairing session state machine", () => {
  beforeEach(() => session.reset());
  afterEach(() => {
    vi.useRealTimers();
    session.reset();
  });

  it("begin() issues a 6-digit code, a 16-byte salt and a future expiry", () => {
    const { code, salt, expiresAt } = session.begin();
    expect(code).toMatch(/^\d{6}$/);
    expect(Buffer.from(salt, "base64").length).toBe(16);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(session.status().active).toBe(true);
  });

  it("refuses a proof when no session is active", () => {
    const { error } = attempt({ deviceId: "d", name: "Phone", proof: "AAAA" });
    expect(error).toMatchObject({ code: "PAIR_NO_SESSION" });
  });

  it("locks out after 3 wrong proofs", () => {
    session.begin();
    const bad = Buffer.alloc(32).toString("base64");
    for (let i = 0; i < 3; i++) {
      expect(attempt({ deviceId: "d", name: "Phone", proof: bad }).error).toMatchObject({
        code: "PAIR_FAILED",
      });
    }
    // Session consumed + locked; even a fresh begin cannot bypass the window.
    expect(session.isLocked()).toBe(true);
    session.begin();
    expect(attempt({ deviceId: "d", name: "Phone", proof: bad }).error).toMatchObject({
      code: "PAIR_LOCKED",
    });
  });

  it("rejects a proof once the code has expired", () => {
    vi.useFakeTimers();
    const { code, salt } = session.begin({ ttlMs: 1000 });
    vi.advanceTimersByTime(1500);
    expect(attempt({ deviceId: "d", name: "Phone", proof: proofFor(code, salt) }).error).toMatchObject({
      code: "PAIR_NO_SESSION",
    });
  });

  it("a correct proof consumes the code and waits for approval", () => {
    const { code, salt } = session.begin();
    const events = [];
    session.setNotifier((e) => events.push(e));

    const { promise, error } = attempt({
      deviceId: "dev-9",
      name: "Pixel",
      platform: "android",
      proof: proofFor(code, salt),
    });
    expect(error).toBeUndefined();
    expect(promise).toBeInstanceOf(Promise);
    // The pending promise must not go unhandled if the test ends early.
    promise.catch(() => {});

    // Client is blocked awaiting the user's decision; code is now consumed.
    expect(session.status().active).toBe(false);
    expect(session.status().pending).toEqual([
      expect.objectContaining({ deviceId: "dev-9", name: "Pixel" }),
    ]);
    expect(events.some((e) => e.type === "pairingRequest")).toBe(true);

    session.setNotifier(() => {});
  });

  it("rejects the waiting client on Deny", async () => {
    const { code, salt } = session.begin();
    const { promise } = attempt({
      deviceId: "dev-x",
      name: "iPhone",
      proof: proofFor(code, salt),
    });
    expect(session.resolve("dev-x", false)).toBe(true);
    await expect(promise).rejects.toMatchObject({ code: "PAIR_DENIED" });
  });

  it("resolve() reports false for an unknown device", () => {
    expect(session.resolve("nobody", true)).toBe(false);
  });
});
