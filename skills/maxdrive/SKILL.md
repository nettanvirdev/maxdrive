---
name: maxdrive
description: Browse, search, download, upload and organize files in MaxDrive - a desktop app that unifies several Google Drive accounts into one file tree with pooled storage. Use when the user wants to find, retrieve, back up, or manage their MaxDrive files, photos, or videos, or asks about their available Drive storage. Requires the MaxDrive desktop app to be running with remote access enabled.
---

# MaxDrive

MaxDrive is a Windows desktop app that merges multiple Google Drive accounts
into a single virtual drive: one file tree, one search, and uploads that land
automatically on whichever account has room. It exposes a local-network MCP
server so an AI assistant can use that pooled storage.

## Connecting

The MaxDrive app must be **running** with **Remote access enabled**
(Settings → "Remote access and devices"). Then either:

- **HTTP (recommended).** In that same Settings section, "Connect an AI assistant (MCP)" →
  "Generate connection command" gives a ready-to-run line:
  `claude mcp add --transport http maxdrive http://<pc-ip>:47821/mcp --header "Authorization: Bearer <token>"`.
  The token is a paired device credential; revoke it anytime from the device
  list.
- **stdio (for clients without HTTP MCP).** Use the bridge in
  [`mcp-bridge/`](mcp-bridge/README.md); it relays stdio JSON-RPC to the same
  HTTP endpoint using the same token.

Everything is LAN-only; nothing is exposed to the internet.

## Identity model

Every file and folder is a **node** with a stable `id` (e.g.
`g:<account>:<fileId>`, or the special MaxDrive root). Pass ids, never names or
paths - names are not unique across pooled accounts. Omit `parentId` to mean the
MaxDrive root.

## Tools

| Tool | Use it to |
|------|-----------|
| `list_files` | List a folder's children (`parentId`, optional `sort`). |
| `search_files` | Find files/folders by name across all accounts (`query`). |
| `list_recent` | Show recently modified files. |
| `get_node` | Get one node's metadata by `id`. |
| `get_path` | Get the breadcrumb path (root → node). |
| `list_accounts` | List connected Google accounts. |
| `get_storage` | Aggregate + per-account quota (how much room is left). |
| `get_download_link` | Temporary authenticated URL for a file's bytes (supports Range). |
| `get_thumbnail_link` | Temporary URL for a file's thumbnail image. |
| `create_folder` | Make a folder (`name`, optional `parentId`). |
| `rename_node` | Rename a node (`id`, `name`). |
| `move_nodes` | Move nodes into a folder (`ids`, `newParentId`). |
| `trash_nodes` | Move nodes to trash (`ids`). |
| `star_node` | Star/unstar (`id`, `starred`). |
| `upload_file` | Upload a file from a path on the PC (`localPath`, optional `parentId`). |

## Recipes

- **Find and download something.** `search_files` → pick the node →
  `get_download_link` → give the user the URL (or fetch it; it streams bytes and
  honours HTTP Range for large media).
- **See what a photo/video looks like.** `get_thumbnail_link` for a preview
  image without pulling the whole file.
- **Check free space before a big upload.** `get_storage` reports the aggregate
  free bytes and each account's headroom; MaxDrive auto-picks the account.
- **Organize.** `create_folder`, then `move_nodes` the results of a
  `search_files` into it. Renames are `rename_node`.
- **Upload.** `upload_file` with a `localPath` on the PC queues a transfer; the
  target account is chosen by free space automatically.

Notes: uploads and moves are queued/asynchronous - the desktop performs them and
its own UI updates live. `get_download_link`/`get_thumbnail_link` URLs are
signed and expire (hours), so fetch them promptly rather than storing them.

## References

- [references/API.md](references/API.md) - the full REST API (for building a
  mobile or web client).
- [references/PROTOCOL.md](references/PROTOCOL.md) - discovery, device pairing,
  WebSocket events and signed URLs.
