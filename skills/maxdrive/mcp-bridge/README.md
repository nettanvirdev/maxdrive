# maxdrive-mcp-bridge

A tiny stdio ↔ HTTP relay for MCP clients that don't speak Streamable HTTP. It
forwards stdio JSON-RPC to MaxDrive's in-app `/mcp` endpoint using a bearer
token. No dependencies; Node 18+.

**Prefer HTTP directly** if your client supports it (e.g. Claude Code):
`claude mcp add --transport http maxdrive http://<pc-ip>:47821/mcp --header "Authorization: Bearer <token>"`.
Use this bridge only for stdio-only clients.

## Get a token

In the MaxDrive app: Settings → "Remote access and devices" → enable it →
"Connect an AI assistant (MCP)" → "Generate connection command". Copy the `<token>` and the
`http://<pc-ip>:47821/mcp` URL. Revoke it anytime from the device list.

## Configure a stdio client

```jsonc
{
  "mcpServers": {
    "maxdrive": {
      "command": "node",
      "args": ["path/to/skills/maxdrive/mcp-bridge/bin.cjs"],
      "env": {
        "MAXDRIVE_MCP_URL": "http://<pc-ip>:47821/mcp",
        "MAXDRIVE_MCP_TOKEN": "<token>"
      }
    }
  }
}
```

That's it - the client launches the bridge over stdio and it talks to the
running MaxDrive app. If MaxDrive isn't running (or remote access is off), calls
fail until it's available again.
