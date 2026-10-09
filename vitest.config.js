import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Separate from vite.config.js because that one sets `root` to src/renderer for
 * the app build, which would hide the tests directory from the runner.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/renderer"),
    },
  },
});
