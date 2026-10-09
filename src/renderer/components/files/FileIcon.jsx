import { Database, Lock } from "lucide-react";
import { fileType } from "@/lib/mime";

export function FileIcon({ mime, isFolder, className = "h-5 w-5" }) {
  const { icon: Icon, color } = fileType(mime, isFolder);
  return <Icon className={`${className} shrink-0`} style={{ color }} />;
}

/**
 * A row's name plus, for vault-mode files, the lock badge. While locked the
 * name is only a placeholder ("Encrypted file"), so it reads as one.
 */
export function FileName({ file }) {
  return (
    <>
      <span
        className={`truncate text-sm ${
          file.sealLocked ? "italic text-muted-foreground" : "text-foreground"
        }`}
      >
        {file.name}
      </span>
      {file.sealed ? (
        <Lock
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-label="Encrypted"
        />
      ) : null}
    </>
  );
}

/**
 * Account identity chip: the profile photo when we have one (stored as a
 * data: URI - remote URLs are blocked by the CSP), otherwise a colored circle
 * with the account's first letter. The hue is derived from the email so the
 * same account always gets the same color.
 */
export function AccountAvatar({ email, photo, provider, size = 20 }) {
  // S3 buckets have no profile photo or person behind them - a bucket glyph
  // tells them apart from Google accounts at a glance.
  if (provider === "s3") {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-drive-variant text-muted-foreground"
        style={{ width: size, height: size }}
        title={email}
      >
        <Database style={{ width: size * 0.55, height: size * 0.55 }} />
      </span>
    );
  }
  if (photo?.startsWith("data:")) {
    return (
      <img
        src={photo}
        alt=""
        title={email}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const letter = (email?.[0] ?? "?").toUpperCase();
  const hue =
    [...(email ?? "")].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        backgroundColor: `hsl(${hue} 55% 45%)`,
      }}
      title={email}
    >
      {letter}
    </span>
  );
}
