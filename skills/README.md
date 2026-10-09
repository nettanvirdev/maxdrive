# MaxDrive skills

Reusable, client-agnostic material for letting AI assistants (and future mobile
apps) drive MaxDrive over its local-network API.

- [`maxdrive/SKILL.md`](maxdrive/SKILL.md) — an Agent Skill: what MaxDrive is,
  how to connect over MCP, the tool catalog, and worked recipes. Point a
  skill-aware client (e.g. Claude) at this folder.
- [`maxdrive/mcp-bridge/`](maxdrive/mcp-bridge/README.md) — a dependency-free
  stdio↔HTTP bridge for MCP clients that don't speak Streamable HTTP.
- [`maxdrive/references/API.md`](maxdrive/references/API.md) — the full REST API,
  for building a native mobile or web client.
- [`maxdrive/references/PROTOCOL.md`](maxdrive/references/PROTOCOL.md) —
  discovery, QR + 6-digit device pairing, WebSocket events, signed URLs.

## Quick connect (Claude Code, HTTP)

1. In the MaxDrive app: Settings → **Remote access and devices** → turn it on.
2. **Connect an AI assistant (MCP)** → **Generate connection command** → copy it.
3. Run the copied line:

```bash
claude mcp add --transport http maxdrive http://<pc-ip>:47821/mcp --header "Authorization: Bearer <token>"
```

The token is a paired-device credential; revoke it anytime from the device list
in the same Settings section. The token is valid for 30 days; generate a new command when it expires. Everything stays on your local network.
