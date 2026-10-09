import { useIpcQuery } from "./useIpcQuery";

/**
 * LAN server status + paired-device list, refetched whenever the main process
 * reports a change (`server:changed`).
 */
export function useServer() {
  const { data } = useIpcQuery(
    async () => ({
      status: await window.maxdrive.server.status(),
      devices: await window.maxdrive.server.listDevices(),
    }),
    [],
    ["serverChanged"],
  );
  return { status: data?.status ?? null, devices: data?.devices ?? [] };
}
