import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  CheckCircle2,
  Smartphone,
  RefreshCw,
  ShieldQuestion,
} from "lucide-react";
import { Modal, ModalButton, ModalError } from "@/components/ui/Modal";
import { toast } from "@/stores/useToastStore";

const api = () => window.maxdrive.server;

/**
 * Desktop-initiated pairing. On open it asks the main process for a fresh
 * 6-digit code + QR, shows both, and waits. When a device proves the code the
 * same dialog switches to an Allow/Deny prompt for that device (the code is
 * consumed on a correct proof, so only the approved device gets in). Mirrors
 * the reference project's on-screen-code + connect-prompt flow.
 */
export function PairDeviceDialog({ onClose }) {
  const [phase, setPhase] = useState("loading"); // loading|code|approve|done|expired|error
  const [info, setInfo] = useState(null); // { code, qr, expiresAt, address }
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [pending, setPending] = useState(null); // device awaiting approval
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef(null);

  const startNew = useCallback(async () => {
    setError(null);
    setPending(null);
    pendingRef.current = null;
    try {
      const next = await api().startPairing();
      setInfo(next);
      setPhase("code");
      setQrDataUrl(await QRCode.toDataURL(next.qr, { margin: 1, width: 220 }));
    } catch (err) {
      setError(err.message);
      setPhase("error");
    }
  }, []);

  // Kick off a pairing session when the dialog mounts.
  useEffect(() => {
    startNew();
  }, [startNew]);

  // A device proved the code and is waiting for the user's decision.
  useEffect(() => {
    const off = window.maxdrive.on.serverPairingRequest((device) => {
      pendingRef.current = device;
      setPending(device);
      setPhase("approve");
    });
    return off;
  }, []);

  // The session ended for a reason other than a successful approval.
  useEffect(() => {
    const off = window.maxdrive.on.serverPairingState((state) => {
      if (!state.active && !pendingRef.current) {
        setPhase(state.reason === "locked" ? "locked" : "expired");
      }
    });
    return off;
  }, []);

  // Countdown while showing the code.
  useEffect(() => {
    if (phase !== "code" || !info?.expiresAt) return undefined;
    const tick = () => {
      const left = Math.max(0, Math.round((info.expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setPhase("expired");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase, info]);

  const close = useCallback(() => {
    // Leave no client hanging: deny an in-flight request, then tear the session down.
    if (pendingRef.current) api().denyPairing(pendingRef.current.deviceId).catch(() => {});
    api().cancelPairing().catch(() => {});
    onClose();
  }, [onClose]);

  const approve = async () => {
    setBusy(true);
    try {
      await api().approvePairing(pending.deviceId);
      setPhase("done");
      toast.success(`${pending.name} connected`);
      setTimeout(onClose, 1600);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const deny = async () => {
    setBusy(true);
    try {
      await api().denyPairing(pending.deviceId);
    } catch {
      /* ignore */
    }
    setBusy(false);
    await startNew(); // hand out a fresh code so the user can try again
  };

  return (
    <Modal
      title="Add a device"
      subtitle={info?.address ? `This PC: ${info.address}` : "Local network only"}
      icon={<Smartphone className="h-5 w-5 text-primary" />}
      width={440}
      onClose={close}
      footer={
        phase === "approve" ? (
          <>
            <ModalButton onClick={deny} busy={busy}>
              Deny
            </ModalButton>
            <ModalButton variant="primary" onClick={approve} busy={busy}>
              Allow
            </ModalButton>
          </>
        ) : phase === "expired" || phase === "locked" ? (
          <>
            <ModalButton onClick={close}>Close</ModalButton>
            <ModalButton variant="primary" icon={RefreshCw} onClick={startNew}>
              New code
            </ModalButton>
          </>
        ) : (
          <ModalButton onClick={close}>
            {phase === "done" ? "Done" : "Cancel"}
          </ModalButton>
        )
      }
    >
      {phase === "loading" ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Starting pairing…
        </p>
      ) : null}

      {phase === "code" ? (
        <div className="flex flex-col items-center gap-4 py-1">
          <p className="text-center text-sm text-muted-foreground">
            On your phone, scan this code or enter the 6 digits. Both devices
            must be on the same Wi-Fi.
          </p>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="Pairing QR code"
              className="h-52 w-52 rounded-lg border border-border bg-white p-2"
            />
          ) : null}
          <div className="text-center">
            <p className="font-mono text-3xl font-semibold tracking-[0.3em] text-foreground">
              {info?.code}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Expires in {Math.floor(remaining / 60)}:
              {String(remaining % 60).padStart(2, "0")}
            </p>
          </div>
        </div>
      ) : null}

      {phase === "approve" && pending ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <ShieldQuestion className="h-10 w-10 text-primary" />
          <p className="text-base font-medium text-foreground">
            {pending.name} wants to connect
          </p>
          <p className="text-xs text-muted-foreground">
            {pending.platform || "device"}
            {pending.remoteIp ? ` · ${pending.remoteIp}` : ""}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Allow this device to browse and back up to MaxDrive?
          </p>
        </div>
      ) : null}

      {phase === "done" ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <CheckCircle2 className="h-10 w-10 text-drive-sheets" />
          <p className="text-base font-medium text-foreground">Device paired</p>
        </div>
      ) : null}

      {phase === "expired" ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          This pairing code expired. Generate a new one to try again.
        </p>
      ) : null}

      {phase === "locked" ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Too many failed attempts. Wait a moment, then generate a new code.
        </p>
      ) : null}

      <ModalError>{error}</ModalError>
    </Modal>
  );
}
