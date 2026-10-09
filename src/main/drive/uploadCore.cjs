/**
 * The resumable-upload protocol, extracted from the upload worker so backups
 * can reuse it against arbitrary Drive parents (and against existing files via
 * update sessions) without inheriting the uploader's allocation and indexing.
 *
 * Google's resumable protocol is the only one that survives a dropped Wi-Fi or
 * a killed app: the session URI stays valid for about a week, and a `308` reply
 * tells us exactly how many bytes actually landed. We trust that number rather
 * than assuming our last chunk arrived intact.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const { accessToken } = require("../auth/googleClient.cjs");

// A multiple of 256 KiB, as Drive requires. 8 MiB keeps memory flat while still
// making few enough requests that a large file isn't dominated by round trips.
const CHUNK = 8 * 1024 * 1024;
const SESSION_TTL_MS = 6 * 24 * 60 * 60 * 1000;

const UPLOAD_FIELDS =
  "id,name,size,md5Checksum,mimeType,webViewLink,createdTime,modifiedTime";

function fail(message, code, retryable = true) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

/**
 * Start a resumable session. `url` decides what it is: POST against /files
 * creates a new file, PATCH against /files/{id} uploads a new revision of an
 * existing one. Body carries metadata only on create.
 */
async function openSession(
  accountId,
  { url, method = "POST", size, mimeType, body },
) {
  const token = await accessToken(accountId);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType || "application/octet-stream",
      "X-Upload-Content-Length": String(size),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 403) {
    const text = await res.text();
    if (text.includes("storageQuotaExceeded")) {
      throw fail("That account filled up.", "storageQuotaExceeded");
    }
    throw fail(text.slice(0, 200), "FORBIDDEN");
  }
  if (!res.ok)
    throw fail(`Could not start upload (${res.status}).`, `HTTP_${res.status}`);

  const uri = res.headers.get("location");
  if (!uri) throw fail("Drive did not return an upload session.", "NO_SESSION");
  return uri;
}

/**
 * Asks Drive how much of the session it already has.
 *
 * Returns one of:
 *   {state:'complete', file}  the upload already finished - possibly on a
 *                             previous run whose response we never saw
 *   {state:'partial', offset} resume from this byte
 *   {state:'dead'}            the session is gone; start over
 *
 * 'complete' matters more than it looks: if the app died after Drive finalized
 * the file but before we recorded it, the only evidence is this reply.
 */
async function probeSession(sessionUri, size, accountId, signal) {
  const token = await accessToken(accountId);
  const res = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Range": `bytes */${size}`,
    },
    signal,
  });

  if (res.status === 200 || res.status === 201) {
    let file = null;
    try {
      file = await res.json();
    } catch {
      /* finalized, but the metadata did not come back - handled by the caller */
    }
    return { state: "complete", file };
  }
  if (res.status === 308) {
    const range = res.headers.get("range");
    // No range header means Drive holds nothing yet, not that a chunk landed.
    return {
      state: "partial",
      offset: range ? Number(range.split("-")[1]) + 1 : 0,
    };
  }
  return { state: "dead" };
}

function readChunk(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    fs.createReadStream(filePath, { start, end })
      .on("data", (c) => chunks.push(c))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

/** Streaming hex hash of a local file - md5 by default, as Drive's checksum is. */
function hashFile(filePath, algo = "md5") {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/**
 * Drive the whole protocol for one file: resume-probe an existing session,
 * open a fresh one via `createSession()` when needed, push chunks, and route
 * every way of finishing through one return shape.
 *
 * Returns {file} - null metadata means Drive finalized but withheld the body.
 * Throws coded errors; notable codes the caller may want to branch on:
 *   storageQuotaExceeded (err.phase = 'session' | 'chunk')
 *   SESSION_GONE (onSessionInvalid() already called)
 *   ABORTED (retryable=false; the queue maps it to paused/canceled)
 */
async function uploadResumable({
  accountId,
  localPath,
  size,
  createSession, // async () => sessionUri
  session = null, // { uri, expiresAt } | null
  onSessionInvalid = () => {},
  signal,
  onProgress,
  setSession, // (uri, expiresAt) => void - persist for resume
}) {
  let sessionUri = null;
  let offset = 0;

  if (session?.uri && (session.expiresAt ?? 0) > Date.now()) {
    const probed = await probeSession(session.uri, size, accountId, signal);
    if (probed.state === "complete") return { file: probed.file, bytes: size };
    if (probed.state === "partial") {
      sessionUri = session.uri;
      offset = probed.offset;
    } else {
      onSessionInvalid();
    }
  }

  if (!sessionUri) {
    try {
      sessionUri = await createSession();
    } catch (err) {
      if (err.code === "storageQuotaExceeded") err.phase = "session";
      throw err;
    }
    setSession(sessionUri, Date.now() + SESSION_TTL_MS);
    offset = 0;
  }

  onProgress(offset);

  while (offset < size) {
    if (signal.aborted) throw fail("Stopped.", "ABORTED", false);

    const end = Math.min(offset + CHUNK, size) - 1;
    const body = await readChunk(localPath, offset, end);

    const res = await fetch(sessionUri, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes ${offset}-${end}/${size}`,
        "Content-Length": String(body.length),
      },
      body,
      signal,
    });

    if (res.status === 308) {
      const range = res.headers.get("range");
      if (range) {
        // Authoritative: never assume the whole chunk landed.
        offset = Number(range.split("-")[1]) + 1;
      } else {
        // No range on a 308 tells us nothing about what was stored. Ask
        // outright rather than optimistically crediting ourselves the chunk.
        const probed = await probeSession(sessionUri, size, accountId, signal);
        if (probed.state === "complete")
          return { file: probed.file, bytes: size };
        if (probed.state === "dead") {
          onSessionInvalid();
          throw fail(
            "The upload session expired; starting over.",
            "SESSION_GONE",
          );
        }
        offset = probed.offset;
      }
      onProgress(offset);
      continue;
    }

    if (res.status === 200 || res.status === 201) {
      let file = null;
      try {
        file = await res.json();
      } catch {
        /* callers cope with missing metadata */
      }
      return { file, bytes: size };
    }

    if (res.status === 404 || res.status === 410) {
      onSessionInvalid();
      throw fail("The upload session expired; starting over.", "SESSION_GONE");
    }

    if (res.status === 403) {
      const text = await res.text();
      if (text.includes("storageQuotaExceeded")) {
        const err = fail(
          "That account filled up mid-upload.",
          "storageQuotaExceeded",
        );
        err.phase = "chunk";
        throw err;
      }
      throw fail(text.slice(0, 200), "FORBIDDEN", false);
    }

    throw fail(`Upload failed (${res.status}).`, `HTTP_${res.status}`);
  }

  // Every byte is accounted for but Drive never sent a final response - ask it
  // to commit so the file still gets recorded rather than left dangling.
  const probed = await probeSession(sessionUri, size, accountId, signal);
  if (probed.state === "complete") return { file: probed.file, bytes: size };
  throw fail(
    "Upload finished but Drive did not confirm it.",
    "NO_CONFIRMATION",
  );
}

/** Session URL for creating a new file (metadata in the body). */
function createFileSessionUrl() {
  return `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${UPLOAD_FIELDS}`;
}

/** Session URL for uploading a new revision of an existing file. */
function updateFileSessionUrl(fileId) {
  return `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable&fields=${UPLOAD_FIELDS}`;
}

module.exports = {
  uploadResumable,
  openSession,
  probeSession,
  hashFile,
  createFileSessionUrl,
  updateFileSessionUrl,
  fail,
  CHUNK,
  SESSION_TTL_MS,
};
