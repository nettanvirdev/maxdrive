/**
 * The authoritative theme and color scheme live in SQLite, but that is only
 * readable after an async IPC round trip - long enough to paint one frame in
 * the wrong palette. Mirroring them to localStorage lets the renderer apply
 * them before React mounts, so there is no flash on launch.
 */
export const DEFAULT_SCHEME = "graphite";

function read(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or storage disabled - the DB copy still wins next launch */
  }
}

export const readStoredTheme = () => read("maxdrive.theme", "system");
export const storeTheme = (theme) => store("maxdrive.theme", theme);
export const readStoredScheme = () => read("maxdrive.scheme", DEFAULT_SCHEME);
export const storeScheme = (scheme) => store("maxdrive.scheme", scheme);

export function applyTheme(theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  return dark;
}

/** Selects a palette block in globals.css (`[data-scheme="..."]`). */
export function applyScheme(scheme) {
  document.documentElement.dataset.scheme = scheme;
}
