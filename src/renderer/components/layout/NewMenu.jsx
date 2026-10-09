import { useRef, useState } from "react";
import { FolderPlus, FolderUp, Plus, Upload } from "lucide-react";
import { runCommand } from "@/commands/dispatch";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useShortcutLabels } from "@/shortcuts/useShortcutLabels";

/**
 * Drive's New button. Uploads always target the folder currently being browsed,
 * falling back to MaxDrive elsewhere - so "New" from the Storage screen still
 * has a sensible destination rather than silently doing nothing.
 *
 * The destination rule and the name prompt both live in the commands now; this
 * is only the button that reaches them.
 */
export function NewMenu({ disabled }) {
  const [at, setAt] = useState(null); // {x, y} while open
  const button = useRef(null);
  const labels = useShortcutLabels();

  const close = (event) => {
    // A press on the button itself is left to its click, which toggles.
    if (event?.type === "mousedown" && button.current?.contains(event.target))
      return;
    setAt(null);
  };

  // Each entry is the same command the keyboard and the palette run, so the
  // New button cannot end up doing something subtly different from Ctrl+U.
  const item = (id, icon, label) => (
    <MenuItem
      icon={icon}
      label={label}
      hint={labels.get(id)}
      onClick={() => {
        setAt(null);
        runCommand(id);
      }}
    />
  );

  return (
    <div className="ml-1 mt-1 w-fit shrink-0">
      <button
        ref={button}
        type="button"
        onClick={() => {
          const rect = button.current.getBoundingClientRect();
          setAt((open) => (open ? null : { x: rect.left, y: rect.bottom + 8 }));
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        title={disabled ? "Connect an account first" : "Create or upload"}
        className="flex h-14 items-center gap-3 rounded-lg bg-card px-5 text-sm font-medium text-foreground shadow-gfloat transition-shadow duration-200 ease-standard hover:shadow-gdrop disabled:opacity-50 disabled:shadow-none"
      >
        <Plus className="h-6 w-6 text-primary" />
        New
      </button>

      {at ? (
        <Menu x={at.x} y={at.y} width={288} onClose={close}>
          {item("file.newFolder", FolderPlus, "New folder")}
          <MenuSeparator />
          {item("file.upload", Upload, "File upload")}
          {item("file.uploadFolder", FolderUp, "Folder upload")}
        </Menu>
      ) : null}
    </div>
  );
}
