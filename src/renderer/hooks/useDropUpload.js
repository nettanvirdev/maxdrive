import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag-and-drop uploads.
 *
 * File.path was removed in Electron 32, so the only way to turn a dropped item
 * into a real path is webUtils.getPathForFile, exposed through the preload as
 * window.maxdrive.getPathForFile. Without it this silently produces nothing.
 *
 * Dragging counts nested enter/leave events, otherwise moving the cursor over a
 * child element reads as "left the drop zone" and the overlay flickers.
 *
 * `onPaths` replaces the default (a normal upload into `destParentId`) - the
 * Secure page uses it to encrypt into the vault instead. While disabled, file
 * drops are still swallowed: an unhandled drop makes Chromium navigate the
 * window to the file.
 */
export function useDropUpload({ destParentId, enabled = true, onPaths }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const onDragEnter = useCallback(
    (event) => {
      if (!enabled || !event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    [enabled]
  );

  const onDragOver = useCallback(
    (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      // Without preventDefault the browser navigates to the file instead.
      event.preventDefault();
      event.dataTransfer.dropEffect = enabled ? "copy" : "none";
    },
    [enabled]
  );

  const onDragLeave = useCallback((event) => {
    event.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    async (event) => {
      event.preventDefault();
      if (!enabled) return;
      reset();

      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return;

      const paths = files
        .map((file) => {
          try {
            return window.maxdrive.getPathForFile(file);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (!paths.length) return;

      // Folders arrive here too; the main process stats each path and expands
      // directories into their own virtual folder tree.
      if (onPaths) await onPaths(paths);
      else await window.maxdrive.transfers.enqueuePaths(paths, destParentId);
    },
    [enabled, destParentId, onPaths, reset]
  );

  return {
    dragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
