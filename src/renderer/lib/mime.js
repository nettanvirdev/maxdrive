import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
} from "lucide-react";

const GOOGLE = "application/vnd.google-apps";

/**
 * Maps a MIME type to the icon and accent colour used throughout the app.
 * `color` is a CSS variable so it flips with the theme.
 */
export function fileType(mime, isFolder = false) {
  if (isFolder || mime === `${GOOGLE}.folder`) {
    return { icon: Folder, color: "var(--muted-foreground)", label: "Folder" };
  }

  switch (mime) {
    case `${GOOGLE}.document`:
      return { icon: FileText, color: "var(--type-docs)", label: "Google Doc" };
    case `${GOOGLE}.spreadsheet`:
      return { icon: FileSpreadsheet, color: "var(--type-sheets)", label: "Google Sheet" };
    case `${GOOGLE}.presentation`:
      return { icon: Presentation, color: "var(--type-slides)", label: "Google Slides" };
    case "application/pdf":
      return { icon: FileText, color: "var(--type-pdf)", label: "PDF" };
    default:
      break;
  }

  if (!mime) return { icon: File, color: "var(--muted-foreground)", label: "File" };
  if (mime.startsWith("image/"))
    return { icon: FileImage, color: "var(--type-sheets)", label: "Image" };
  if (mime.startsWith("video/"))
    return { icon: FileVideo, color: "var(--type-video)", label: "Video" };
  if (mime.startsWith("audio/"))
    return { icon: FileAudio, color: "var(--type-slides)", label: "Audio" };
  if (/zip|compressed|tar|rar|7z/.test(mime))
    return { icon: FileArchive, color: "var(--text-tertiary)", label: "Archive" };
  if (/javascript|json|xml|html|css|typescript/.test(mime))
    return { icon: FileCode, color: "var(--type-docs)", label: "Code" };
  if (mime.startsWith("text/"))
    return { icon: FileText, color: "var(--muted-foreground)", label: "Text" };

  return { icon: File, color: "var(--muted-foreground)", label: "File" };
}

const BY_EXTENSION = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", heic: "image/heic",
  mp4: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4",
  pdf: "application/pdf",
  zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
  tar: "application/x-tar", gz: "application/gzip",
  json: "application/json", js: "application/javascript", ts: "application/typescript",
  html: "text/html", css: "text/css", xml: "application/xml",
  txt: "text/plain", md: "text/markdown", csv: "text/csv",
  doc: "application/msword", docx: "application/msword",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.ms-powerpoint",
};

/**
 * Best-effort type from a filename. Transfers are queued before Drive has said
 * anything about the file, so the tray has nothing but the name to go on.
 */
export function mimeFromName(name = "") {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}
