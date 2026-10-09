import { useEffect, useState } from "react";
import { AccountAvatar, FileIcon } from "./FileIcon";
import { Modal, ModalButton } from "@/components/ui/Modal";
import { formatBytes, formatWhen } from "@/lib/format";

const VERBS = {
  uploaded: "Uploaded",
  created: "Created",
  renamed: "Renamed",
  moved: "Moved",
  trashed: "Moved to trash",
  restored: "Restored from trash",
  downloaded: "Downloaded",
  shared: "Shared",
  migrated: "Moved to another account",
};

/**
 * The answers to "where does this actually live and what happened to it" —
 * which account holds the bytes, which virtual folder shows it, and the
 * activity we recorded for it.
 */
export function DetailsDialog({ node, onClose }) {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    window.maxdrive.nodes
      .activity(node.id)
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [node.id]);

  const rows = [
    { label: "Type", value: node.is_folder ? "Folder" : node.mime || "File" },
    { label: "Size", value: node.is_folder ? "—" : formatBytes(node.size) },
    {
      label: "Stored on",
      value: node.account_email || "Local index only (virtual folder)",
    },
    { label: "Location", value: node.parent_name || "MaxDrive" },
    { label: "Created", value: formatWhen(node.created_at) || "—" },
    { label: "Modified", value: formatWhen(node.modified_at) || "—" },
    {
      label: "Sharing",
      value: node.share_link ? "Anyone with the link" : "Restricted",
    },
  ];

  return (
    <Modal
      title={node.name}
      label={`Details for ${node.name}`}
      subtitle={node.is_folder ? "Folder" : formatBytes(node.size)}
      icon={<FileIcon mime={node.mime} isFolder={Boolean(node.is_folder)} />}
      width={480}
      onClose={onClose}
      footer={
        <ModalButton variant="primary" onClick={onClose}>
          Done
        </ModalButton>
      }
    >
      <dl className="overflow-hidden rounded-lg border border-border">
        {rows.map((row, index) => (
          <div
            key={row.label}
            className={`flex items-center gap-3 px-3 py-2.5 ${
              index ? "border-t border-border" : ""
            }`}
          >
            <dt className="w-24 shrink-0 text-xs text-muted-foreground">
              {row.label}
            </dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
              {row.label === "Stored on" && node.account_email ? (
                <AccountAvatar
                  email={node.account_email}
                  photo={node.account_photo}
                  provider={node.account_provider}
                  size={20}
                />
              ) : null}
              <span className="truncate" title={String(row.value)}>
                {row.value}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <p className="mb-2 mt-5 text-xs font-medium text-muted-foreground">
        Activity
      </p>
      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          Nothing recorded - this file was indexed from its storage rather
          than changed here.
        </p>
      ) : (
        <div className="max-h-[200px] overflow-y-auto rounded-lg border border-border">
          {events.map((event, index) => (
            <div
              key={event.id}
              className={`px-3 py-2.5 ${index ? "border-t border-border" : ""}`}
            >
              <p className="text-sm text-foreground">
                {VERBS[event.kind] || event.kind}
                {event.detail ? ` - ${event.detail}` : ""}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatWhen(event.at)}
                {event.account_email ? ` · ${event.account_email}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
