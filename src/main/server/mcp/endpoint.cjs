/**
 * In-app MCP server over Streamable HTTP (`/mcp`).
 *
 * Hand-rolled JSON-RPC 2.0 rather than the ESM-only SDK: the main process is
 * CommonJS, and the request/response tools here need none of the SDK's session
 * or SSE machinery. It reuses the LAN server's bearer auth and calls the SAME
 * services as the REST API and IPC layer (db/queries, ops, queue), so an AI
 * assistant gets exactly the capabilities the desktop UI has.
 *
 * Stateless: each POST is a self-contained JSON-RPC message (or batch). We
 * answer requests with application/json and notifications with 202, which is a
 * valid Streamable HTTP server profile for a tools-only server.
 */
const { nodes, accounts } = require("../../db/queries.cjs");
const { MANAGED_ROOT_ID } = require("../../db/database.cjs");
const ops = require("../../ops.cjs");
const { queue } = require("../../transfers/queue.cjs");
const serialize = require("../serialize.cjs");
const token = require("../auth/token.cjs");
const { app } = require("electron");

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** Absolute base URL the client used, for building shareable links. */
function baseUrl(ctx) {
  return `http://${ctx.req.headers.host}`;
}

function signedMediaUrl(ctx, kind, id, extra = "") {
  const { exp, sig } = token.signUrl(id, ctx.signingKey);
  return `${baseUrl(ctx)}/v1/${kind}/${encodeURIComponent(id)}?exp=${exp}&sig=${encodeURIComponent(sig)}${extra}`;
}

/* --------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: "list_files",
    description:
      "List the files and folders inside a MaxDrive folder. Omit parentId for the MaxDrive root.",
    inputSchema: {
      type: "object",
      properties: {
        parentId: { type: "string", description: "Folder node id; omit for root." },
        sort: { type: "string", enum: ["name", "modified", "size"] },
      },
    },
    run: (args) =>
      serialize.nodes(nodes.children(args.parentId || MANAGED_ROOT_ID, args.sort || "name")),
  },
  {
    name: "search_files",
    description: "Full-text search files and folders by name across all connected accounts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results (default 50)." },
      },
      required: ["query"],
    },
    run: (args) => serialize.nodes(nodes.search(args.query, Math.min(args.limit || 50, 500))),
  },
  {
    name: "get_node",
    description: "Get metadata for a single file or folder by its node id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: (args) => {
      const n = nodes.byId(args.id);
      if (!n) throw new Error("No such node.");
      return serialize.node(n);
    },
  },
  {
    name: "get_path",
    description: "Get the breadcrumb path (root → node) for a node id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: (args) => serialize.nodes(nodes.path(args.id)),
  },
  {
    name: "list_recent",
    description: "List the most recently modified files.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
    run: (args) => serialize.nodes(nodes.recent(Math.min(args.limit || 50, 500))),
  },
  {
    name: "list_accounts",
    description: "List the connected Google Drive accounts.",
    inputSchema: { type: "object", properties: {} },
    run: () => serialize.accounts(accounts.list()),
  },
  {
    name: "get_storage",
    description: "Get aggregate and per-account storage usage across all accounts.",
    inputSchema: { type: "object", properties: {} },
    run: () => serialize.storage(accounts.list()),
  },
  {
    name: "get_download_link",
    description:
      "Get a temporary authenticated URL to download or stream a file's bytes (supports HTTP Range).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: (args, ctx) => {
      const n = nodes.byId(args.id);
      if (!n) throw new Error("No such node.");
      if (n.is_folder) throw new Error("Folders have no bytes.");
      return { url: signedMediaUrl(ctx, "file", n.id), name: n.name, mime: n.mime };
    },
  },
  {
    name: "get_thumbnail_link",
    description: "Get a temporary authenticated URL for a file's thumbnail image.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        size: { type: "number", description: "Pixel size (default 440)." },
      },
      required: ["id"],
    },
    run: (args, ctx) => {
      const n = nodes.byId(args.id);
      if (!n) throw new Error("No such node.");
      return { url: signedMediaUrl(ctx, "thumb", n.id, `&s=${args.size || 440}`) };
    },
  },
  {
    name: "create_folder",
    description: "Create a new folder. Omit parentId to create at the MaxDrive root.",
    inputSchema: {
      type: "object",
      properties: { parentId: { type: "string" }, name: { type: "string" } },
      required: ["name"],
    },
    run: (args) =>
      serialize.node(ops.mkdir({ parentId: args.parentId || MANAGED_ROOT_ID, name: args.name })),
  },
  {
    name: "rename_node",
    description: "Rename a file or folder.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      required: ["id", "name"],
    },
    run: async (args) => serialize.node(await ops.rename({ id: args.id, name: args.name })),
  },
  {
    name: "move_nodes",
    description: "Move one or more files/folders into another folder.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        newParentId: { type: "string", description: "Destination folder; omit for root." },
      },
      required: ["ids"],
    },
    run: (args) => ops.move({ ids: args.ids, newParentId: args.newParentId || MANAGED_ROOT_ID }),
  },
  {
    name: "trash_nodes",
    description: "Move one or more files/folders to the trash.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
    run: (args) => ops.trash({ ids: args.ids }),
  },
  {
    name: "star_node",
    description: "Star or unstar a file or folder.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, starred: { type: "boolean" } },
      required: ["id", "starred"],
    },
    run: (args) => ops.star({ id: args.id, starred: args.starred }),
  },
  {
    name: "upload_file",
    description:
      "Upload a file from a path on THIS computer into MaxDrive. The right account is chosen automatically by free space.",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute path on the server machine." },
        parentId: { type: "string", description: "Destination folder; omit for root." },
      },
      required: ["localPath"],
    },
    run: (args) => {
      const fs = require("node:fs");
      const stat = fs.statSync(args.localPath);
      if (!stat.isFile()) throw new Error("Not a file.");
      const id = queue.enqueueUpload(
        args.localPath,
        args.parentId || MANAGED_ROOT_ID,
        { size: stat.size },
      );
      return { transferId: id, queued: true };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/* --------------------------------------------------------- JSON-RPC core */

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatch(msg, ctx) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg?.id !== undefined ? rpcError(msg.id, -32600, "Invalid Request") : undefined;
  }
  const isNotification = msg.id === undefined || msg.id === null;

  // Notifications (initialized, cancelled, …) get no response.
  if (isNotification) return undefined;

  switch (msg.method) {
    case "initialize": {
      const wanted = msg.params?.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0];
      return rpcResult(msg.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "MaxDrive", version: app.getVersion() },
        instructions:
          "MaxDrive unifies multiple Google Drive accounts into one file tree. Use list_files/search_files to browse, get_download_link for bytes, and the create/rename/move/trash tools to manage files.",
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "resources/list":
      return rpcResult(msg.id, { resources: [] });
    case "prompts/list":
      return rpcResult(msg.id, { prompts: [] });
    case "tools/call": {
      const tool = TOOL_MAP.get(msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const data = await tool.run(msg.params.arguments || {}, ctx);
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
      } catch (err) {
        // Tool execution failures are reported as tool errors, not RPC errors,
        // so the model can read and react to them.
        return rpcResult(msg.id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/* ------------------------------------------------------------- transport */

/** Route handler for POST/GET/DELETE /mcp. Writes the response and returns RAW. */
async function handle(ctx, RAW) {
  const { req, res } = ctx;
  if (req.method === "GET" || req.method === "DELETE") {
    // No server-initiated stream and nothing to tear down (stateless).
    res.writeHead(req.method === "DELETE" ? 200 : 405).end();
    return RAW;
  }

  const body = ctx.body;
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  const responses = [];
  for (const m of messages) {
    const r = await dispatch(m, ctx);
    if (r !== undefined) responses.push(r);
  }

  if (responses.length === 0) {
    res.writeHead(202).end(); // notifications only
    return RAW;
  }
  const payload = batch ? responses : responses[0];
  const text = JSON.stringify(payload);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
  return RAW;
}

module.exports = { handle };
