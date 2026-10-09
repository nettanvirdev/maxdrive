import { useState } from "react";
import { Smartphone, Wifi, WifiOff, Trash2, Copy } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Group, Toggle } from "@/components/ui/SettingsGroup";
import { runCommand } from "@/commands/dispatch";
import { useServer } from "@/hooks/useServer";
import { toast } from "@/stores/useToastStore";

const api = () => window.maxdrive.server;

const PLATFORM_LABEL = {
  ios: "iPhone / iPad",
  android: "Android",
  mcp: "AI assistant (MCP)",
  other: "Device",
};

/**
 * Settings section that turns the LAN server on/off, starts pairing, and lists
 * paired devices with a Revoke action. Off by default - no socket binds until
 * the user opts in here.
 */
export function RemoteAccessSettings() {
  const { status, devices } = useServer();
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(null);

  const enabled = Boolean(status?.enabled);
  const running = Boolean(status?.running);

  const toggle = async () => {
    setBusy(true);
    try {
      if (enabled) await api().disable();
      else await api().enable();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const active = devices.filter((d) => !d.revoked);

  return (
    <>
      <Group title="Remote access and devices">
        <Toggle
          label="Allow phones and AI assistants on this network"
          hint="Starts a local-network server so paired devices can browse and back up to MaxDrive. Nothing is exposed to the internet."
          checked={enabled}
          disabled={busy}
          onChange={toggle}
        />

        {/* Status + add device */}
        {enabled ? (
          <div className="flex items-center gap-3 p-4">
            {running ? (
              <Wifi className="h-5 w-5 shrink-0 text-drive-sheets" />
            ) : (
              <WifiOff className="h-5 w-5 shrink-0 text-drive-slides" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">
                {running ? "Server running" : "Server not reachable"}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {running
                  ? `http://${status.address}:${status.port} · ${status.clients} connected`
                  : "Check your firewall allows MaxDrive on private networks."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => runCommand("server.addDevice")}
              disabled={!running}
              className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-shadow hover:shadow-gcard disabled:opacity-50"
            >
              <Smartphone className="h-4 w-4" />
              Add device
            </button>
          </div>
        ) : null}

        {/* Paired devices */}
        {enabled ? (
          <div className="p-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Paired devices
            </p>
            {active.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No devices yet. Choose “Add device” to pair your phone.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {active.map((device) => (
                  <div
                    key={device.id}
                    className="flex items-center gap-3 px-3 py-2"
                  >
                    <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">
                        {device.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {PLATFORM_LABEL[device.platform] || device.platform} ·
                        last seen{" "}
                        {device.lastSeenAt
                          ? new Date(device.lastSeenAt).toLocaleString()
                          : "never"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRevoking(device)}
                      className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-destructive hover:bg-[var(--hover-overlay)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* MCP connection hint */}
        {enabled && running ? <McpRow /> : null}
      </Group>

      {revoking ? (
        <ConfirmDialog
          title="Revoke this device?"
          message={`${revoking.name} will lose access immediately and must pair again to reconnect.`}
          confirmLabel="Revoke"
          danger
          onConfirm={async () => {
            await api().revokeDevice(revoking.id);
            toast.success(`Revoked ${revoking.name}`);
          }}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </>
  );
}

/** Generates a paired MCP token + a ready-to-run `claude mcp add` command. */
function McpRow() {
  const [conn, setConn] = useState(null); // { command, url }
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      setConn(await window.maxdrive.server.createMcpToken("Claude"));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4">
      <p className="text-sm text-foreground">Connect an AI assistant (MCP)</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Let Claude and other MCP clients browse and manage your files. Generates
        a trusted connection you can revoke anytime from the device list above.
      </p>

      {conn ? (
        <>
          <div className="mt-3 flex items-start gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border border-border bg-background px-2 py-1.5 text-[11px] leading-5 text-muted-foreground">
              {conn.command}
            </code>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(conn.command);
                toast.success("Command copied");
              }}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-primary hover:bg-[var(--hover-overlay)]"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Run this in a terminal, or add the URL{" "}
            <span className="font-mono">{conn.url}</span> with the bearer token as
            a custom connector. The token is a secret — treat it like a password.
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="mt-3 flex h-9 items-center gap-2 rounded-full border border-border px-4 text-sm font-medium text-primary transition-colors hover:bg-[var(--hover-overlay)] disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate connection command"}
        </button>
      )}
    </div>
  );
}
