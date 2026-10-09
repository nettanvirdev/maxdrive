import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, X } from "lucide-react";
import { FileIcon } from "@/components/files/FileIcon";
import { runCommand } from "@/commands/dispatch";
import { buildContext } from "@/commands/context";
import { formatBytes } from "@/lib/format";

const TEXT_LIMIT = 1024 * 1024; // beyond this a "preview" is just a slow download

/** Secure files go out through the vault (which decrypts); others don't. */
const saveNode = (node) =>
  node.vault
    ? window.maxdrive.vault.download([node.id])
    : window.maxdrive.transfers.enqueueDownload(node.id);

/**
 * Kind-switched preview, served over maxfile:// for indexed Drive files and
 * maxvault:// for secure ones. Either way the main process holds the token and
 * proxies Range requests, which is what lets video scrub and Chromium's PDF
 * viewer page through without downloading the whole file. The vault scheme
 * additionally decrypts the requested chunks on the fly, so previewing a
 * secure file never writes plaintext to disk.
 */
export function PreviewModal({ node, onClose }) {
  const kind = previewKind(node);
  const src = node.vault
    ? `maxvault://item/${encodeURIComponent(node.id)}`
    : `maxfile://node/${encodeURIComponent(node.id)}`;

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portalled for the same reason as Modal: the page wrapper's fade-in
  // transform would otherwise make "fixed inset-0" mean the content surface
  // rather than the window, and the preview would sit inside the file list.
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex animate-scrim-in flex-col bg-black/85"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-14 shrink-0 items-center gap-3 px-4"
        onClick={(event) => event.stopPropagation()}
        role="presentation"
      >
        <FileIcon mime={node.mime} isFolder={false} />
        <span className="min-w-0 flex-1 truncate text-sm text-white">{node.name}</span>
        <span className="shrink-0 text-xs text-white/50">{formatBytes(node.size)}</span>
        {node.web_view_link && node.account_provider === "gdrive" ? (
          <TopButton
            icon={ExternalLink}
            label="Open in Drive"
            onClick={() => runCommand("file.openExternal", { ...buildContext(), node })}
          />
        ) : null}
        {!node.is_google_doc ? (
          <TopButton icon={Download} label="Download" onClick={() => saveNode(node)} />
        ) : null}
        <TopButton icon={X} label="Close" onClick={onClose} />
      </div>

      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6"
        onClick={(event) => event.stopPropagation()}
        role="presentation"
      >
        <Body kind={kind} node={node} src={src} onClose={onClose} />
      </div>
    </div>,
    document.body
  );
}

function previewKind(node) {
  const mime = node.mime || "";
  if (node.is_google_doc) return "external";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (
    (mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml" ||
      mime === "application/javascript") &&
    (node.size ?? 0) <= TEXT_LIMIT
  ) {
    return "text";
  }
  return "none";
}

function Body({ kind, node, src, onClose }) {
  const [failed, setFailed] = useState(false);

  if (failed || kind === "none" || kind === "external") {
    return <Fallback node={node} onClose={onClose} />;
  }

  if (kind === "image") {
    return (
      <img
        src={src}
        alt={node.name}
        onError={() => setFailed(true)}
        className="max-h-full max-w-full rounded-md object-contain shadow-gdrop"
      />
    );
  }

  if (kind === "video") {
    return (
      /* eslint-disable-next-line jsx-a11y/media-has-caption */
      <video
        src={src}
        controls
        autoPlay
        onError={() => setFailed(true)}
        className="max-h-full max-w-full rounded-md shadow-gdrop"
      />
    );
  }

  if (kind === "audio") {
    return (
      <div className="flex w-[420px] max-w-full flex-col items-center gap-4 rounded-lg bg-card p-8">
        <FileIcon mime={node.mime} isFolder={false} className="h-12 w-12" />
        <p className="max-w-full truncate text-sm text-foreground">{node.name}</p>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={src} controls autoPlay onError={() => setFailed(true)} className="w-full" />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <iframe
        src={src}
        title={node.name}
        className="h-full w-full rounded-md border-0 bg-white shadow-gdrop"
      />
    );
  }

  return <TextPreview src={src} node={node} onFail={() => setFailed(true)} />;
}

function TextPreview({ src, node, onFail }) {
  const [text, setText] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(src)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((value) => !cancelled && setText(value))
      .catch(() => !cancelled && onFail());
    return () => {
      cancelled = true;
    };
  }, [src, onFail]);

  if (text === null) return <p className="text-sm text-white/70">Loading…</p>;
  return (
    <pre className="h-full w-full overflow-auto rounded-md bg-card p-4 text-xs leading-relaxed text-foreground">
      {text}
    </pre>
  );
}

function Fallback({ node, onClose }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-card p-10 text-center">
      <FileIcon mime={node.mime} isFolder={false} className="h-14 w-14" />
      <p className="max-w-[360px] truncate text-sm text-foreground">{node.name}</p>
      <p className="text-xs text-muted-foreground">
        {node.is_google_doc
          ? "Google Docs open on the web"
          : `${formatBytes(node.size)} · no preview for this type`}
      </p>
      {node.is_google_doc ? (
        <button
          type="button"
          onClick={() => {
            runCommand("file.openExternal", { ...buildContext(), node });
            onClose();
          }}
          className="mt-2 flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:shadow-gcard"
        >
          <ExternalLink className="h-4 w-4" />
          Open in Drive
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            saveNode(node);
            onClose();
          }}
          className="mt-2 flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:shadow-gcard"
        >
          <Download className="h-4 w-4" />
          Download
        </button>
      )}
    </div>
  );
}

function TopButton({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
