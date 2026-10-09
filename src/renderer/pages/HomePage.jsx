import { useEffect, useState } from "react";
import { CloudOff, FolderOpen, History, Plus, X } from "lucide-react";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/files/EmptyState";
import { FileGridView } from "@/components/files/FileGridView";
import { FileListView } from "@/components/files/FileListView";
import { FolderCard } from "@/components/files/FolderCard";
import { ItemMenu } from "@/components/files/ItemMenu";
import { useSelectionStore } from "@/stores/useSelectionStore";
import { runCommand } from "@/commands/dispatch";
import { buildContext } from "@/commands/context";
import { ViewModeToggle } from "@/components/files/ViewModeToggle";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useUiStore } from "@/stores/useUiStore";
import { useNodes } from "@/hooks/useNodes";

/** Checked once per launch - the lookup costs one Drive call per account. */
let restoreChecked = false;

/**
 * After a Windows reinstall the app comes up empty and offers only "connect an
 * account", so the cloud backup sitting in that very Drive goes unnoticed and
 * the virtual folder tree is quietly lost. This says so, once, when the two
 * conditions that mean "fresh install over an existing Drive" both hold: this
 * installation has never written a backup, yet backups exist.
 */
function RestoreNotice() {
  const { navigate } = useUiStore();
  const [found, setFound] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (restoreChecked) return;
    restoreChecked = true;
    let cancelled = false;

    (async () => {
      try {
        const status = await window.maxdrive.index.status();
        if (status?.generation) return; // This install already backs up.
        const candidates = await window.maxdrive.index.listRestoreCandidates();
        if (!cancelled) setFound(candidates?.length ?? 0);
      } catch {
        /* offline or not yet authorised - nothing worth interrupting for */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!found || dismissed) return null;

  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-drive-variant px-4 py-3">
      <History className="h-5 w-5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          Found a backup of your MaxDrive index
        </span>
        <span className="block text-xs text-muted-foreground">
          Restoring it brings back your folder structure. Your files in Google
          Drive are not touched either way.
        </span>
      </span>
      <button
        type="button"
        onClick={() => navigate({ view: "settings" })}
        className="h-9 shrink-0 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-shadow duration-200 ease-standard hover:shadow-gcard"
      >
        Review backups
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--hover-overlay)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function HomePage({ folders = [], hasAccounts }) {
  const { viewMode, update } = useSettingsStore();
  const { navigate } = useUiStore();
  const [menu, setMenu] = useState(null);
  // Real recents from the index rather than a placeholder list.
  const { items: files } = useNodes("recent");

  // Home shows recents, so that list is what the keyboard acts on here.
  const setList = useSelectionStore((state) => state.setList);
  useEffect(() => setList(files), [files, setList]);

  const open = (node) => runCommand("file.open", { ...buildContext(), node });
  const openMenu = (node, x, y) => setMenu({ node, x, y });
  const showLocation = (node) =>
    runCommand("file.showLocation", { ...buildContext(), node });

  return (
    <PageShell title="Welcome to MaxDrive">
      <div className="animate-fade-in">
        {!hasAccounts ? (
          <EmptyState
            icon={CloudOff}
            title="No accounts connected yet"
            description="Connect Google Drive accounts or S3-compatible buckets and MaxDrive will merge them into a single drive, choosing where each upload goes for you."
            action={
              <button
                type="button"
                onClick={() => navigate({ view: "accounts" })}
                className="flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-shadow duration-200 ease-standard hover:shadow-gcard"
              >
                <Plus className="h-4 w-4" />
                Connect an account
              </button>
            }
          />
        ) : (
          <>
            <RestoreNotice />
            <CollapsibleSection title="Suggested folders">
              {folders.length ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                  {folders.map((folder) => (
                    <FolderCard
                      key={folder.id}
                      folder={folder}
                      onOpen={open}
                      onMenu={openMenu}
                    />
                  ))}
                </div>
              ) : (
                <p className="px-1 text-sm text-muted-foreground">
                  Folders you use often will appear here.
                </p>
              )}
            </CollapsibleSection>

            <CollapsibleSection
              title="Suggested files"
              actions={
                files.length ? (
                  <ViewModeToggle
                    value={viewMode}
                    onChange={(mode) => update({ viewMode: mode })}
                  />
                ) : null
              }
            >
              {files.length ? (
                viewMode === "list" ? (
                  <FileListView
                    files={files}
                    onOpen={open}
                    onOpenLocation={showLocation}
                    onMenu={openMenu}
                  />
                ) : (
                  <FileGridView files={files} onOpen={open} onMenu={openMenu} />
                )
              ) : (
                <EmptyState
                  icon={FolderOpen}
                  title="Nothing here yet"
                  description="Once your Drives are indexed, files you have opened recently show up here."
                />
              )}
            </CollapsibleSection>
          </>
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
