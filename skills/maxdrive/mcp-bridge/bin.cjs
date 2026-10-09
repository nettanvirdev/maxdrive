#!/usr/bin/env node
/**
 * MaxDrive MCP stdio ↔ HTTP bridge.
 *
 * For MCP clients that only speak stdio (not Streamable HTTP). It relays each
 * newline-delimited JSON-RPC message from stdin to MaxDrive's in-app `/mcp`
 * endpoint over HTTP with a bearer token, and writes each response back to
 * stdout. No dependencies - Node 18+ (global fetch).
 *
 * Config via env:
 *   MAXDRIVE_MCP_URL    e.g. http://192.168.1.20:47821/mcp
 *   MAXDRIVE_MCP_TOKEN  the bearer token from MaxDrive Settings
 */
const readline = require("node:readline");

const URL = process.env.MAXDRIVE_MCP_URL;
const TOKEN = process.env.MAXDRIVE_MCP_TOKEN;

if (!URL || !TOKEN) {
  process.stderr.write(
    "maxdrive-mcp-bridge: set MAXDRIVE_MCP_URL and MAXDRIVE_MCP_TOKEN.\n",
  );
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: trimmed,
    });
    if (res.status === 202) return; // a notification: no response to relay
    const text = await res.text();
    // stdio framing is one JSON object per line.
    process.stdout.write(text.replace(/\r?\n/g, "") + "\n");
  } catch (err) {
    // Surface transport failures as a JSON-RPC error if we can parse the id.
    let id = null;
    try {
      id = JSON.parse(trimmed).id ?? null;
    } catch {
      /* ignore */
    }
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `bridge: ${err.message}` },
      }) + "\n",
    );
  }
});

rl.on("close", () => process.exit(0));
