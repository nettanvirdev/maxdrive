import { useEffect, useState } from "react";
import { ArrowRightLeft, ChevronLeft } from "lucide-react";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuHeader,
} from "@/components/ui/Menu";
import { AccountAvatar } from "./FileIcon";
import { accountName } from "@/lib/accounts";
import { COMMAND_MAP, isAvailable } from "@/commands/registry";
import { buildContext } from "@/commands/context";
import { runCommand } from "@/commands/dispatch";
import { useShortcutLabels } from "@/shortcuts/useShortcutLabels";
import { toast } from "@/stores/useToastStore";

/**
 * The ⋮ / right-click menu, rendered from the command registry.
 *
 * Each group is a list of command ids; a command that is unavailable for this
 * node simply doesn't appear, which is the same `when` rule the keyboard and the
 * palette use. The menu no longer owns any behaviour of its own, so an action
 * cannot behave differently here than it does from a keystroke.
 */
const GROUPS = [
  ["file.open", "file.preview", "file.openExternal", "file.download"],
  [
    "file.share",
    "file.copyLink",
    "file.createLink",
    "file.star",
    "file.unstar",
  ],
  ["file.rename", "file.move", "file.duplicate"],
  ["file.showLocation", "file.details"],
  ["file.restore", "file.deleteForever", "file.trash"],
];

export function ItemMenu({ node, x, y, onClose }) {
  const [page, setPage] = useState("root"); // root | accounts
  const [accounts, setAccounts] = useState([]);
  const labels = useShortcutLabels();

  useEffect(() => {
    window.maxdrive.accounts
      .list()
      .then((all) => setAccounts(all.filter((a) => a.auth_state === "ok")))
      .catch(() => setAccounts([]));
  }, []);

  /**
   * Right-clicking a row outside the selection acts on that row alone; inside
   * it, the menu acts on the whole selection - so "Move to trash" on three
   * selected files trashes three files, as the same command does from Delete.
   */
  const base = buildContext();
  const selected = base.nodes.some((item) => item.id === node.id);
  const nodes = selected && base.nodes.length ? base.nodes : [node];
  const context = { ...base, node, nodes, hasSelection: true };

  const item = (id) => {
    const command = COMMAND_MAP.get(id);
    if (!command || !isAvailable(command, context)) return null;
    return (
      <MenuItem
        key={id}
        icon={command.icon}
        label={titleFor(command, nodes)}
        hint={labels.get(id)}
        danger={command.danger}
        onClick={async () => {
          onClose();
          await runCommand(id, context);
        }}
      />
    );
  };

  const canMigrate =
    node.drive_file_id &&
    node.account_id &&
    !node.is_google_doc &&
    !node.is_folder;
  const others = accounts.filter((a) => a.id !== node.account_id);

  /* ------------------------------------------------- move-to-account page */
  if (page === "accounts") {
    return (
      <Menu x={x} y={y} onClose={onClose} width={280}>
        <MenuItem
          icon={ChevronLeft}
          label="Back"
          onClick={() => setPage("root")}
        />
        <MenuSeparator />
        <MenuHeader>Move to another account</MenuHeader>
        {others.length === 0 ? (
          <MenuItem label="No other accounts connected" disabled />
        ) : (
          others.map((account) => (
            <MenuItem
              key={account.id}
              icon={() => (
                <AccountAvatar
                  email={account.email}
                  photo={account.photo_url}
                  provider={account.provider}
                  size={16}
                />
              )}
              label={accountName(account)}
              onClick={async () => {
                onClose();
                try {
                  const result =
                    await window.maxdrive.transfers.enqueueMigration(
                      node.id,
                      account.id,
                    );
                  toast.info(
                    `${result.queued} file queued for ${accountName(account)}`,
                  );
                } catch (err) {
                  toast.error(err.message);
                }
              }}
            />
          ))
        )}
      </Menu>
    );
  }

  /* ------------------------------------------------------------ root page */
  const groups = GROUPS.map((group) => group.map(item).filter(Boolean)).filter(
    (group) => group.length,
  );

  return (
    <Menu x={x} y={y} onClose={onClose}>
      {groups.map((group, index) => (
        <div key={index}>
          {index > 0 ? <MenuSeparator /> : null}
          {group}
        </div>
      ))}

      {canMigrate ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={ArrowRightLeft}
            label="Move to another account"
            hint="›"
            onClick={() => setPage("accounts")}
          />
        </>
      ) : null}
    </Menu>
  );
}

/**
 * "Move to trash" reads oddly for a virtual folder that only exists locally,
 * and a multi-selection deserves a count rather than one file's name.
 */
function titleFor(command, nodes) {
  if (
    command.id === "file.trash" &&
    nodes.length === 1 &&
    nodes[0].origin === "vfolder"
  ) {
    return "Delete folder";
  }
  if (
    nodes.length > 1 &&
    ["file.trash", "file.download", "file.restore"].includes(command.id)
  ) {
    return `${command.title} (${nodes.length})`;
  }
  return command.title;
}
