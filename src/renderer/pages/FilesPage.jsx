import { useEffect, useState } from "react";
import {
  ChevronRight,
  CloudOff,
  FolderOpen,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { EmptyState } from "@/components/files/EmptyState";
import { PageShell } from "@/components/layout/PageShell";
import { FileGridView } from "@/components/files/FileGridView";
import { FileListView } from "@/components/files/FileListView";
import { ViewModeToggle } from "@/components/files/ViewModeToggle";
import { FileActions } from "@/components/files/FileActions";
import { ItemMenu } from "@/components/files/ItemMenu";
import { useNodes, useBreadcrumbs } from "@/hooks/useNodes";
import { useSelectionStore } from "@/stores/useSelectionStore";
import { runCommand } from "@/commands/dispatch";
import { buildContext } from "@/commands/context";
import { useUiStore } from "@/stores/useUiStore";

const EMPTY = {
  browse: {
    icon: FolderOpen,
    title: "This folder is empty",
    description: "Use the New button to upload files or create a folder here.",
  },
  recent: {
    icon: CloudOff,
    title: "Nothing recent yet",
    description:
      "Files you open or upload show up here once your Drives are indexed.",
  },
  starred: {
    icon: Star,
    title: "No starred files",
    description: "Star a file from its menu and it will be listed here.",
  },
  trash: {
    icon: Trash2,
    title: "Trash is empty",
    description: "Items you delete stay here until you remove them for good.",
  },
  search: {
    icon: Search,
    title: "No matches",
    description: "Nothing in the index matches that search.",
  },
};

/**
 * One page backs browse, recent, starred, trash and search. They differ only in
 * which query feeds them and what an empty result means, so splitting them into
 * five near-identical components would just be five places to fix a bug.
 */
export function FilesPage({ source, folderId, query, hasAccounts }) {
  const { viewMode, setViewMode, openFolder } = useUiStore();
  const { items, loading, error } = useNodes(
    source,
    source === "search" ? query : folderId,
  );
  const trail = useBreadcrumbs(source === "browse" ? folderId : null);
  const [menu, setMenu] = useState(null); // { node, x, y }

  // Publish what's on screen so commands fired from the keyboard or the palette
  // can resolve the selection without this page handing it to them.
  const { ids, setList } = useSelectionStore();
  useEffect(() => setList(items), [items, setList]);

  // Opening a folder should not carry the old folder's selection along.
  useEffect(() => useSelectionStore.getState().clear(), [source, folderId, query]);

  const open = (node) => runCommand("file.open", { ...buildContext(), node });
  const openMenu = (node, x, y) => setMenu({ node, x, y });
  const showLocation = (node) =>
    runCommand("file.showLocation", { ...buildContext(), node });

  const title =
    source === "search"
      ? `Results for "${query}"`
      : source === "browse"
        ? trail[trail.length - 1]?.name || "MaxDrive"
        : source[0].toUpperCase() + source.slice(1);

  // The toolbar acts on a single item; with several selected the ⋮ menu and the
  // keyboard remain the way to act on the whole set.
  const selected = ids.length === 1 ? items.find((item) => item.id === ids[0]) || null : null;

  return (
    <PageShell
      title={
        source === "browse" && trail.length > 1 ? (
          <Breadcrumbs trail={trail} onOpen={openFolder} />
        ) : (
          title
        )
      }
      actions={
        <>
          {selected ? (
            <FileActions node={selected} onMenu={openMenu} />
          ) : null}
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
        </>
      }
    >
      <div className="animate-fade-in">
        {error ? (
          <p className="mb-4 rounded-lg border border-border bg-drive-variant p-4 text-sm text-foreground">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <div className="flex min-h-[320px] items-center justify-center">
            <EmptyState
              {...(hasAccounts === false
                ? {
                    icon: CloudOff,
                    title: "Connect an account first",
                    description:
                      "This view fills in once an account is connected.",
                  }
                : EMPTY[source] || EMPTY.browse)}
            />
          </div>
        ) : viewMode === "grid" ? (
          <FileGridView files={items} onOpen={open} onMenu={openMenu} />
        ) : (
          <div className="overflow-x-auto">
            <FileListView
              files={items}
              onOpen={open}
              onOpenLocation={showLocation}
              onMenu={openMenu}
            />
          </div>
        )}
      </div>

      {menu ? (
        <ItemMenu
          node={menu.node}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </PageShell>
  );
}

function Breadcrumbs({ trail, onOpen }) {
  return (
    <nav className="flex min-w-0 items-center gap-1 text-[22px] font-normal leading-7 text-foreground">
      {trail.map((node, index) => {
        const last = index === trail.length - 1;
        return (
          <span key={node.id} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
            ) : null}
            {last ? (
              <span className="truncate">{node.name}</span>
            ) : (
              <button
                type="button"
                onClick={() => onOpen(node.id)}
                className="truncate rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                {node.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
