import { afterAll, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

// credentials.cjs needs electron's app/safeStorage. Seed require's cache with a
// stub (resolving electron does not run it) so the real binary never loads.
const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "maxdrive-cred-"));
require.cache[require.resolve("electron")] = {
  exports: {
    app: { getPath: () => userData },
    safeStorage: { isEncryptionAvailable: () => false },
  },
};
require.cache[require.resolve("../src/main/logger.cjs")] = {
  exports: { scope: () => ({ info() {}, warn() {}, error() {} }) },
};
const credentials = require("../src/main/auth/credentials.cjs");

afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

it("validates, stores, and prefers saved credentials over .env", () => {
  process.env.GOOGLE_CLIENT_ID = "env.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "env-secret";
  expect(credentials.status()).toEqual({ ready: true, source: "env" });

  expect(() => credentials.set({ clientId: "nope", clientSecret: "x" })).toThrow(
    expect.objectContaining({ code: "INVALID_CREDENTIALS" }),
  );

  expect(
    credentials.set({ clientId: " ui.apps.googleusercontent.com ", clientSecret: " s " }),
  ).toEqual({ ready: true, source: "stored" });
  expect(credentials.get()).toEqual({
    clientId: "ui.apps.googleusercontent.com",
    clientSecret: "s",
  });
  expect(fs.existsSync(path.join(userData, "oauth-client.bin"))).toBe(true);

  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});
