/**
 * jsdom omits a few browser APIs the renderer touches at import time. Stubbing
 * them here keeps the modules under test importable without each test having to
 * know which store reads what.
 */

// useSettingsStore subscribes to the OS dark-mode preference on import.
if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
}

// The preload bridge only exists inside Electron.
if (!window.maxdrive) {
  window.maxdrive = {
    settings: { get: async () => ({}), set: async () => {} },
  };
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
