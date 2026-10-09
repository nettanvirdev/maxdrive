import { useEffect, useState } from "react";
import { useIpcQuery } from "./useIpcQuery";

const NONE = [];

/** Loads a node listing and keeps it fresh on every nodes:changed event. */
export function useNodes(source, key) {
  const { data: items = NONE, loading, error } = useIpcQuery(
    () => {
      const api = window.maxdrive?.nodes;
      // "browse" is what FilesPage calls it; both names mean the same query, and
      // only accepting one of them is how folder browsing silently returned
      // nothing at all.
      if (source === "browse" || source === "children")
        return api.children(key || undefined);
      if (source === "recent") return api.recent(50);
      if (source === "starred") return api.starred();
      if (source === "trash") return api.trashed();
      if (source === "search") return key ? api.search(key) : NONE;
      return NONE;
    },
    [source, key],
    ["nodesChanged"],
  );
  return { items, loading, error };
}

/** Breadcrumb trail for the current folder; empty at a root. */
export function useBreadcrumbs(folderId) {
  const [path, setPath] = useState([]);

  useEffect(() => {
    if (!folderId) {
      setPath([]);
      return;
    }
    window.maxdrive?.nodes
      .path(folderId)
      .then(setPath)
      .catch(() => setPath([]));
  }, [folderId]);

  return path;
}
