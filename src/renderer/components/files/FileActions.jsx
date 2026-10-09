import { MoreVertical } from "lucide-react";
import { COMMAND_MAP, isAvailable } from "@/commands/registry";
import { buildContext } from "@/commands/context";
import { runCommand } from "@/commands/dispatch";
import { useShortcutLabels } from "@/shortcuts/useShortcutLabels";
import { IconButton } from "@/components/ui/IconButton";

/**
 * Quick actions for the selected row.
 *
 * Each button is just a command id: the behaviour, the availability rule and
 * the label all come from the registry, so this cannot drift from the ⋮ menu.
 * It used to re-implement star / trash / download / open-in-Drive inline, and
 * the copies had already diverged - the toolbar offered Download for files the
 * menu did not.
 */
const TOOLBAR = [
  "file.open",
  "file.openExternal",
  "file.preview",
  "file.download",
  "file.share",
  "file.star",
  "file.unstar",
  "file.trash",
];

export function FileActions({ node, onMenu }) {
  const labels = useShortcutLabels();
  // The toolbar acts on the row it is showing, which is not always the store's
  // idea of focus once the pointer has been elsewhere.
  const context = {
    ...buildContext(),
    node,
    nodes: [node],
    hasSelection: true,
  };

  return (
    <div className="flex items-center gap-1">
      {TOOLBAR.map((id) => {
        const command = COMMAND_MAP.get(id);
        if (!command || !isAvailable(command, context)) return null;

        const shortcut = labels.get(id);
        return (
          <IconButton
            key={id}
            icon={command.icon}
            label={shortcut ? `${command.title} (${shortcut})` : command.title}
            active={
              id === "file.unstar" ||
              (id === "file.share" && Boolean(node.share_link))
            }
            onClick={() => runCommand(id, context)}
          />
        );
      })}

      <IconButton
        icon={MoreVertical}
        label="More actions"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu?.(node, rect.right, rect.bottom + 6);
        }}
      />
    </div>
  );
}
