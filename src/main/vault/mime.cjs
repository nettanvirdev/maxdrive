/**
 * Extension → MIME type.
 *
 * Normal uploads let Drive sniff the type from the bytes, but a vault blob is
 * opaque ciphertext with a uuid for a name - Drive can tell us nothing about
 * it. So the type has to be captured here, at the moment we still have the
 * real file, and stored (encrypted) with the item. Preview depends on it.
 */
const path = require("node:path");

const TYPES = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  // video
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  // audio
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/opus",
  aac: "audio/aac",
  // documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // text and code
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  log: "text/plain",
  json: "application/json",
  xml: "application/xml",
  yml: "text/yaml",
  yaml: "text/yaml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  jsx: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  py: "text/plain",
  rb: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  sh: "text/plain",
  sql: "text/plain",
  ini: "text/plain",
  toml: "text/plain",
  // archives
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  gz: "application/gzip",
  tar: "application/x-tar",
};

const DEFAULT = "application/octet-stream";

function mimeOf(filePath) {
  const ext = path.extname(String(filePath)).replace(/^\./, "").toLowerCase();
  return TYPES[ext] || DEFAULT;
}

module.exports = { mimeOf };
