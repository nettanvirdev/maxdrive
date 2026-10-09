/**
 * Provider helpers. Accounts are Google Drive unless `provider` says "s3";
 * rows from before S3 support have no provider at all and are Drive.
 */
export const isS3 = (account) => account?.provider === "s3";
export const isDrive = (account) => !isS3(account);

/** Drive-only features (sharing, thumbnails, "Open in Drive") check this. */
export const onDrive = (node) => node?.account_provider === "gdrive";

/** Short name: the Google email, or an S3 account's label / bucket. */
export function accountName(account) {
  if (!isS3(account)) return account?.email;
  return account.display_name || account.config?.bucket || account.email;
}

/** "AWS S3" for a blank endpoint, else the endpoint's host. */
export function s3Host(endpoint) {
  if (!endpoint) return "AWS S3";
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** "bucket/prefix · host" for an S3 account row. */
export function s3Location(account) {
  const { bucket = "", prefix = "", endpoint } = account?.config || {};
  const path = prefix ? `${bucket}/${prefix.replace(/^\/+|\/+$/g, "")}` : bucket;
  return `${path} · ${s3Host(endpoint)}`;
}
