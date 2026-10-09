import { useEffect, useState } from "react";
import { Cloud, Folder } from "lucide-react";
import { Modal, ModalButton, ModalError } from "@/components/ui/Modal";

/**
 * Virtual-tree picker for "Move to". Only vfolders are valid destinations —
 * moving into a mirrored Drive folder would imply moving the physical file,
 * which is what "Move to another account" is for.
 */
export function MoveDialog({ node, onClose }) {
  const [tree, setTree] = useState([]);
  const [target, setTarget] = useState(null); // null = MaxDrive root
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Flatten the virtual tree, depth-first, max 4 levels deep.
      const out = [];
      const walk = async (parentId, depth) => {
        if (depth > 4) return;
        const kids = await window.maxdrive.nodes.children(
          parentId || undefined,
        );
        for (const kid of kids) {
          if (!kid.is_folder || kid.origin !== "vfolder") continue;
          if (kid.id === node.id) continue; // can't move into itself
          out.push({ ...kid, depth });
          await walk(kid.id, depth + 1);
        }
      };
      await walk(null, 0);
      if (!cancelled) setTree(out);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [node.id]);

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.maxdrive.ops.move([node.id], target);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const current =
    target === null ? "MaxDrive" : tree.find((f) => f.id === target)?.name;

  return (
    <Modal
      title="Move to"
      subtitle={node.name}
      label={`Move ${node.name}`}
      width={460}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
            Destination: {current}
          </span>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" busy={busy} onClick={move}>
            Move
          </ModalButton>
        </>
      }
    >
      {/* No scroller of its own - the dialog body already scrolls, and nesting
          two would put two scrollbars side by side. */}
      <div className="rounded-lg border border-border py-1">
        <Choice
          icon={Cloud}
          label="MaxDrive"
          depth={0}
          selected={target === null}
          onClick={() => setTarget(null)}
        />
        {tree.map((folder) => (
          <Choice
            key={folder.id}
            icon={Folder}
            label={folder.name}
            depth={folder.depth + 1}
            selected={target === folder.id}
            onClick={() => setTarget(folder.id)}
          />
        ))}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Folders here are MaxDrive&apos;s own; the file keeps living on the same
        account. Use “Move to another account” to move the bytes.
      </p>

      <ModalError>{error}</ModalError>
    </Modal>
  );
}

function Choice({ icon: Icon, label, depth, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-10 w-full items-center gap-2.5 pr-3 text-left text-sm transition-colors duration-150 ease-standard ${
        selected
          ? "bg-[var(--selected-overlay)] font-medium text-primary"
          : "text-foreground hover:bg-[var(--hover-overlay)]"
      }`}
      style={{ paddingLeft: 12 + depth * 20 }}
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${selected ? "" : "text-muted-foreground"}`}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}
