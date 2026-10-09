# MaxDrive - Architecture and Edge-Case Behaviour

This document answers the edge cases by describing the invariants that make the
answers fall out, then states what the code **actually does today** with file
references.

It began as an audit that found 20 defects. Those have since been fixed, and the
behaviour described below is the behaviour after the fixes - the
[defect register](#defect-register) at the end records what each one was.

Status legend used throughout: **OK** = implemented and correct ·
**PARTIAL** = works but has a named limit · **BY DESIGN** = a deliberate scope
boundary.

---

## 1. The six invariants

Almost every question below is a consequence of one of these. They are the
architecture; everything else is mechanism.

### I1 - Drive owns bytes and existence; the index owns structure

Every fact about a file - that it exists, its name, size, md5, parents, trashed
state - is re-derivable from the Drive API at any time. Exactly one thing is
**not** derivable: the _virtual_ folder tree (a `vfolder` hierarchy, plus which
virtual folder each `managed` file hangs under). That asymmetry is why the index
backup exists at all, and why it only needs to protect a few thousand rows
rather than the whole file corpus.

Corollary: **losing the local database is never data loss.** It costs a rescan
and, absent a backup, the virtual tree.

### I2 - Identity is an ID, never a name or a path

A node's primary key is `g:<accountId>:<driveFileId>`
([scanner.cjs:23](../src/main/sync/scanner.cjs:23)), enforced by
`UNIQUE(account_id, drive_file_id)`
([migrations.cjs:51](../src/main/db/migrations.cjs:51)). `nodes.name` carries no
constraint whatsoever.

This is what makes renames, moves, and duplicate names non-events: a rename is
an `UPDATE name`, a move is an `UPDATE drive_parent_id`, and two files called
`report.pdf` in the same folder are simply two rows.

### I3 - Account identity is Google's `permissionId`, not the email

Set at [accountService.cjs:48](../src/main/auth/accountService.cjs:48). Emails
can be renamed; `permissionId` cannot. Because it is the primary key and connect
is an `INSERT … ON CONFLICT DO UPDATE`, **reconnecting is idempotent by
construction** - there is no duplicate-detection code because a duplicate row
cannot be represented.

### I4 - Durable state lives in SQLite, never in memory

Transfer state, resumable-upload session URIs, per-account change page tokens,
byte reservations. The in-memory queue holds only `AbortController`s
([queue.cjs](../src/main/transfers/queue.cjs)). A crash is therefore just a
restart that reads the same rows.

> **S3 accounts** (`accounts.provider='s3'`) bend I2 and I5 by necessity: an
> object's identity *is* its key, so a rename is copy + delete and the index row
> is re-keyed (`nodes.rekey`); and S3 has no change feed, so the poller re-lists
> each S3 account every 15 min (full listing + `pruneMissing`). Trash and star
> are index-only flags there. Free space comes from the user-set limit minus
> indexed bytes, never an API.

> **Vault mode** bends I1 for sealed items: their names exist only inside
> `nodes.seal_meta` (sealed to the vault-mode public key), so a fresh scan
> after total DB loss shows them as `<uuid>.mxv`. The bytes stay decryptable
> with the recovery key alone (it derives the private key); the names come
> back only with an index restore.

### I5 - The change feed reconciles; scans only bootstrap and repair

Steady state costs one `changes.list` per account per poll. A full
`files.list` scan happens on first connect, after a restore, and when Drive
rejects the page token. Never otherwise.

### I6 - Recovery is a ladder, and each rung loses strictly more

```
1. changes.list backlog        loses nothing
2. rescan one account          loses nothing (mirrored rows rebuilt)
3. restore index from Drive    loses changes since the last snapshot
4. fresh index + full scan     loses the virtual tree only
```

No rung touches bytes in Drive. The worst outcome of total local loss is a flat
view of files that all still exist.

---

## 2. The eleven architectural questions

**1. What is the authoritative source of truth?**
Hybrid, split by concern (I1). Drive is authoritative for file facts; the local
index is authoritative for virtual structure. They cannot conflict because Drive
has no concept of a virtual folder. Concretely, a remote move re-parents only
`origin='mirrored'` rows - a managed node's virtual position is deliberately left
alone ([changePoller.cjs:68-77](../src/main/sync/changePoller.cjs:68)).

**2. How is the index rebuilt after a Windows reset?**
Snapshots are `VACUUM INTO` → gzip → uploaded to `MaxDrive/.index/` in _every_
connected account ([backup.cjs:75-93](../src/main/sync/backup.cjs:75)), 3
generations retained each. On a wiped machine the `accounts` table is empty, so
candidate discovery falls back to the encrypted token store and re-discovers the
`.index` folders ([backup.cjs:221-235](../src/main/sync/backup.cjs:221)) - the
one code path that specifically exists for this scenario. Restore verifies
`PRAGMA integrity_check` on a staging copy _before_ touching the live DB
([backup.cjs:281-285](../src/main/sync/backup.cjs:281)), then nulls every page
token and forces clean rescans ([backup.cjs:292](../src/main/sync/backup.cjs:292)).

After a Windows reset the DPAPI blobs are unreadable too, so the user connects
one account first; the snapshot in _that_ Drive is then enough to rebuild
everything. Because the app would otherwise never mention this, the home page
watches for the one combination that means "fresh install over an existing
Drive" - this installation has never written a backup, yet backups exist - and
offers to restore ([HomePage.jsx](../src/renderer/pages/HomePage.jsx)). Restore
verifies the snapshot's checksum, its `integrity_check`, and its schema version
before the live index is touched.

**3. How are changes detected without rescanning?**
`changes.getStartPageToken` once, then `changes.list` per account, 45 s focused /
5 min blurred ([changePoller.cjs:19-20](../src/main/sync/changePoller.cjs:19)),
with a coalesced 2.5 s poll after our own writes to swallow the echo
([changePoller.cjs:172](../src/main/sync/changePoller.cjs:172)). The token is
persisted only when Drive returns `newStartPageToken`
([changePoller.cjs:112](../src/main/sync/changePoller.cjs:112)), so a crash
mid-backlog replays from the old token - safe, because upserts are idempotent.

**4. How is a newly added account indexed incrementally?**
It isn't incremental, and it shouldn't be - a new account has no prior state.
It gets its own sequential full scan
([scanner.cjs:194-206](../src/main/sync/scanner.cjs:194)); the other accounts are
untouched because all sync state is per-account (`sync_state` keyed by
`account_id`). The global index is never "rebuilt"; there is no global anything.

**5. How is a removed account handled without corrupting the index?**
Disconnect offers keep-or-purge, with an impact count shown first
([accountService.cjs:134-142](../src/main/auth/accountService.cjs:134)). Purge
deletes that account's rows and sync state; keep marks them
`status='orphaned'`. Foreign keys are `ON`, and vfolder rows have no
`account_id`, so the virtual tree survives either way.

Reconnecting the same account clears the flag and the files come back
([accountService.cjs](../src/main/auth/accountService.cjs)); while it is set,
the file list marks those rows "Unavailable" rather than letting them look
ordinary and fail only on open.

**6. How do uploads resume after a crash?**
Session URI and expiry are persisted per transfer
([queue.cjs:259](../src/main/transfers/queue.cjs:259)); 8 MiB chunks; on boot,
`running`/`allocating` rows are forced to `paused` and optionally re-queued
([queue.cjs:45-71](../src/main/transfers/queue.cjs:45)). On resume the true
offset is re-probed from Drive rather than trusted from the DB
([uploader.cjs:64-73](../src/main/drive/uploader.cjs:64)).

**7. How does allocation avoid race conditions?**
In-flight bytes are reserved _derivatively_ - the allocator subtracts
`SUM(size - bytes_done)` over all non-terminal uploads already assigned to that
account ([allocation.cjs:13-30](../src/main/allocation.cjs:13)). Because the
reservation lives in the same table as the transfers, it survives restarts.

The pick and the assignment are **not** in one transaction; instead the queue
only ever lets one unallocated upload (`key === "*"`) be in flight at a time,
which serialises the window. It is correct by scheduling rather than by locking.
Migrations count on both sides - they reserve bytes on their target account and
occupy both a read slot and that account's write slot, since a migration is a
download and an upload at once.

**8. How does it stay inside Google's quotas?**
Every single Drive call carries a `fields` projection (all 20 endpoints —
verified exhaustively), `pageSize` is capped, scans are strictly sequential with
an explicit comment that parallelism would race the per-project limit
([scanner.cjs:194](../src/main/sync/scanner.cjs:194)), and there is **no
`Promise.all` anywhere in `src/main`**. Backups are debounced 5 min, skipped
entirely when a content fingerprint shows the tree is unchanged
([backup.cjs:113-117](../src/main/sync/backup.cjs:113)).

Rate limiting is handled in the HTTP layer itself
([googleClient.cjs](../src/main/auth/googleClient.cjs)), so scans, polls,
backups and file operations all inherit it rather than each needing its own
retry. It honours `Retry-After`, backs off exponentially with jitter, and draws
two distinctions that matter: a 403 is retried only for rate-limit reasons (never
for `storageQuotaExceeded`, which must fail fast so the uploader can
re-allocate), and a 5xx is retried only on idempotent methods - repeating a
`POST` after a lost response would create a second folder.

**9. What is stored locally?**
`%APPDATA%/maxdrive/`: `maxdrive.db` (WAL, `foreign_keys=ON`), `tokens.bin`,
`oauth-client.bin` (both `safeStorage`/DPAPI), `thumbs/`, logs.

**10. What is stored in Drive?**
Files under `MaxDrive/`, and index snapshots under `MaxDrive/.index/`. Both the
scanner and the poller skip `.index` so backups never appear as user files
([scanner.cjs:150](../src/main/sync/scanner.cjs:150),
[changePoller.cjs:60](../src/main/sync/changePoller.cjs:60)).

**11. What is the simplest reliable architecture that does all this?**
The one in place: _one_ `nodes` table with an `origin` discriminator (vfolder /
managed / mirrored) rather than parallel tables, ID-based identity, per-account
sync state, DB-backed queue, and a single gzipped snapshot replicated to all
accounts. The discriminator is what keeps browse, search, and breadcrumbs as
plain queries instead of UNIONs.

---

## 3. Edge cases by category

### Account management

| #   | Question                       | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Remove an account              | **OK.** Purge deletes rows + sync state; keep sets `status='orphaned'` and `auth_state='disconnected'`, metadata retained, and the files show as "Unavailable". Refresh token revoked server-side ([accountService.cjs:114](../src/main/auth/accountService.cjs:114)). Reconnect re-upserts on the same PK and clears the flag.                                                                                                                                                                         |
| 2   | Add an account months later    | **OK.** Own full scan only; all sync state is per-account, nothing global is rebuilt. Incremental sync starts from its own fresh `startPageToken`.                                                                                                                                                                                                                                                                                                                                                      |
| 3   | Same account connected twice   | **OK by construction (I3).** Idempotent upsert on `permissionId`; no duplicate row is representable. Logged, not errored ([accountService.cjs:61](../src/main/auth/accountService.cjs:61)).                                                                                                                                                                                                                                                                                                             |
| 4   | Account with millions of files | **PARTIAL.** App stays usable - the scan is fire-and-forget, commits per 1000-file page, and streams progress ([main.cjs:87](../src/main/main.cjs:87)). It checkpoints `sync_state.scan_cursor` after every committed page, so a crash costs one page rather than the whole scan, and resumes against the _original_ start time so its own earlier pages aren't pruned. Still not user-pausable - the only control is that it runs in the background.                                                   |
| 5   | Access revoked                 | **OK.** `invalid_grant` → `auth_state='reauth_required'` ([googleClient.cjs:39-43](../src/main/auth/googleClient.cjs:39)). Everything schedulable iterates `accounts.active()` (`WHERE auth_state='ok'`), so polling, scanning, quota refresh and allocation all stop for that account only. Reauth uses `login_hint` and **verifies the returned `permissionId` matches**, rejecting a wrong-account pick ([accountService.cjs:51-58](../src/main/auth/accountService.cjs:51)). Metadata is untouched. |

### Windows reset, reinstall, migration

| #   | Question                | Behaviour                                                                                                                                                                                                                                                                                            |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Full Windows reset      | **OK.** See Q2 above - snapshot in every account, discovery offered on the home page, verified before the swap.                                                                                                                                                                                      |
| 7   | New computer            | **OK.** Same restore path; the snapshot is portable and lives in Drive. Multi-device merge is explicitly out of scope.                                                                                                                                                                               |
| 8   | DB corrupted or deleted | **OK.** `PRAGMA integrity_check` on boot; a corrupt file is _renamed_ to `.corrupt-<ts>` rather than deleted, and a fresh DB is created ([database.cjs:55-88](../src/main/db/database.cjs:55)). Rebuild correctness is verified by integrity check + node count on the staging copy before the swap. |
| 9   | Multiple computers      | **BY DESIGN: single-device, last-write-wins.** The index is device-specific; the generation counter is monotonic so the newest snapshot wins. Two machines running concurrently will clobber each other's virtual tree. Not a defect - a documented scope limit.                                     |

### File synchronisation

| #   | Question                                         | Behaviour                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | Deleted on drive.google.com                      | **OK.** Detected within one poll (≤45 s focused). A mirrored row is deleted - it was only ever a reflection of Drive. A managed row (something _we_ uploaded) is instead flagged `status='missing_remote'` and shown as "Unavailable", so a file the user put there never vanishes silently. |
| 11  | Renamed / moved externally                       | **OK.** Metadata-only re-upsert, no rescan (I5).                                                                                                                                                                                                                                             |
| 12  | Modified while offline                           | **OK.** Page token is unchanged, so the next successful poll drains the whole backlog. If the gap exceeded Drive's token retention, the 410 path wipes mirrored rows and rescans that account only.                                                                                          |
| 13  | Moved between folders externally                 | **OK and deliberate.** Mirrored rows follow Drive; managed rows keep their virtual position (I1).                                                                                                                                                                                            |
| 14  | Two files with the same name                     | **OK.** Names carry no identity (I2). Both rows coexist. Minor: sibling ordering has no tiebreaker beyond name, so display order of identically-named siblings is not deterministic.                                                                                                         |
| 15  | Identical names _and_ structures across accounts | **OK.** Distinct `account_id`, distinct PKs, separate synthetic per-account roots.                                                                                                                                                                                                           |

### Uploads

| #   | Question                     | Behaviour                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16  | Interrupted upload           | **OK.** Resumes via the persisted session and a Drive-side offset probe, never a remembered byte count. A 308 without a `Range` header re-probes rather than assuming the chunk landed. Crucially, a probe reporting "already complete" routes into the same finalize path as a normal finish - otherwise a file that landed just as the app died would exist on Drive with no index row. |
| 17  | Account fills mid-upload     | **OK.** `storageQuotaExceeded` detected at both session-creation and mid-chunk; forces a quota refresh, re-allocates, restarts on the next account with a toast ([uploader.cjs:163-175](../src/main/drive/uploader.cjs:163), [:221-227](../src/main/drive/uploader.cjs:221)). Abandoned resumable sessions never materialise a file, so no duplicate in the normal case.                  |
| 18  | File larger than any account | **OK.** Refused with a message naming the largest free slot ([allocation.cjs](../src/main/allocation.cjs)), marked non-retryable so it fails immediately instead of grinding through eight rounds of backoff that cannot create space.                                                                                                                                                    |
| 19  | Many large uploads at once   | **OK.** Derived byte reservation (Q7) plus one-upload-per-account.                                                                                                                                                                                                                                                                                                                        |
| 20  | Same file uploaded twice     | **BY DESIGN.** No content dedupe; name collisions produce `file (2).ext`. Drive itself allows duplicates, and silently discarding a re-upload is worse than storing it.                                                                                                                                                                                                                   |

### Downloads and background operations

| #   | Question                | Behaviour                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21  | Interrupted download    | **OK.** `Range` resume onto a `.maxdrivepart` file, fsync, then rename. The partial is only promoted to the real filename once its length matches and its md5 matches Drive's - a stream can end early without erroring, and a plausible-looking broken file is worse than an obvious failure. Both checks delete the partial and retry. |
| 22  | App closed mid-transfer | **OK.** Fully DB-persisted. Auto-resume distinguishes `paused_by='system'` (crash) from `'user'`, so it restarts what the crash stopped and leaves deliberate pauses alone.                                                                                                                                                              |
| 23  | Sleep during a transfer | **OK.** `powerMonitor` suspend/resume hooks hold transfers and release them on wake, instead of each one separately discovering the same dead socket.                                                                                                                                                                                    |
| 24  | Network change          | **OK.** A failure while offline parks the transfer as `paused_by='system'` **without consuming a retry attempt**, and a watcher re-queues everything once the connection returns. An overnight outage no longer fails the queue permanently.                                                                                             |
| 25  | Concurrency             | **OK.** Global 3, per-account uploads 1, downloads 2, DB-backed queue. Not user-configurable.                                                                                                                                                                                                                                            |

### Index and metadata

Questions 26–32 are answered by I1, I5 and I6 above. Specifics:

- **28 - stale metadata**: detected only via the change feed; there is no
  periodic drift audit. Acceptable, because the feed is authoritative.
- **29 - sync fails halfway**: safe. The page token advances only at the end of a
  drain, and upserts are idempotent, so a partial drain replays.
- **30 - crash mid-index-update**: migrations are transactional per version
  ([database.cjs:29-36](../src/main/db/database.cjs:29)), scans commit per page,
  and each page of changes is applied in one transaction - `applyChange` writes a
  row and then fixes its parent link, and a crash between the two would otherwise
  leave a stale `parent_id`.
- **31/32 - rebuilding without downloading content**: metadata-only. No file
  bytes are ever fetched for indexing; thumbnails are the only content reads.

### Allocation (33–37)

Strategy is **worst-fit**: filter to accounts where
`free ≥ size + headroom`, then take the largest `free`
([allocation.cjs:56-64](../src/main/allocation.cjs:56)). `free` uses
`storageQuota.usage` - the _total_ pool including Gmail and Photos - not
`usageInDrive`, which is the difference between promising space that exists and
space that doesn't. Headroom defaults to 200 MB and is user-adjustable.

- **35 - reservation**: yes, derived from the `transfers` table (Q7), covering
  uploads and migrations alike.
- **36 - manual override**: **OK.** A pinned account is passed to the allocator
  as a _preference_, so it still gets a space check and falls back to the best
  alternative if it cannot hold the file - rather than skipping allocation and
  discovering the problem as a 403 mid-upload. A transfer holding a live
  resumable session is pinned to that account regardless, since re-deciding
  would abandon the bytes already sent.
- **37 - threshold**: no 90/95 % warning exists; headroom is the only guard.

### API limits and account safety (38–45)

Expensive operations under the weighted model are writes (50) and listing (100).
The design minimises all of them: projections everywhere, change feed instead of
rescans, sequential fan-out, fingerprint-gated backups, TTL-cached quota.

Patterns that are genuinely safe here: no parallel scans, no unbounded fan-out
except thumbnails, focus-aware polling that chains `setTimeout` _after_ the
await so polls cannot overlap.

Three things specifically keep the traffic shape well-behaved:

- **Backoff lives in the HTTP layer**, so nothing hammers a rate-limited API.
- **The destructive rescan trigger is narrow.** Only a 410 or an explicit
  `invalidPageToken` wipes an account's mirrored rows and rescans. A generic 400
  is a malformed request, not an expired cursor, and treating it as one turned a
  repeatable bug into a rescan loop - the exact pattern that looks abusive.
- **Thumbnail fetches are capped at four in flight.** Each cache miss costs two
  calls, so scrolling into a folder of several hundred uncached files was the
  only unbounded fan-out left in the main process.

### Security (46–50)

Tokens: `safeStorage` (DPAPI) → `tokens.bin`; OAuth client credentials come
entered in Settings, encrypted the same way in `oauth-client.bin` (a dev `.env`
is the fallback). PKCE S256 + verified `state`, ephemeral
loopback on port 0, 180 s timeout. The renderer never sees a token - it only
ever learns `{ready: boolean}`.

- **48/49 - DB copied to another machine**: the database contains **no
  credentials**, and DPAPI blobs are user- and machine-bound, so a copied
  `maxdrive.db` grants no Drive access. Correct by design.
- **46 - fallback**: if `safeStorage` is unavailable, tokens are written in
  **plaintext** ([tokenStore.cjs](../src/main/auth/tokenStore.cjs)). Acceptable
  on Windows where DPAPI is always present, but it fails open rather than closed.
- **50 - secure deletion**: removal is a JS `delete` plus a file rewrite; old
  ciphertext is not overwritten in place. Low risk given the blob is DPAPI-bound
  and useless off this machine.
- **Unreadable token store**: starting empty is correct after a reinstall, but
  the file is now moved aside first rather than left to be overwritten by the
  next write. Otherwise one bad read destroyed _every_ account's tokens, not
  just the one that failed. Writes are write-then-rename, so a crash mid-write
  can't create that state to begin with.

### Updates and compatibility (51–54)

`PRAGMA user_version` with per-version transactional migrations; currently at
**v3**. Failure rolls back and aborts boot rather than half-migrating.

- **Downgrade guard**: opening a database newer than the build understands is
  refused with an explanatory error instead of silently skipping every migration
  and writing against a schema it doesn't know. Restore applies the same check
  to a snapshot _before_ swapping it in, so a too-new backup can't leave the app
  unable to open at all.
- A failed migration still aborts boot; unlike corruption, it has no move-aside
  recovery.
- No auto-updater, no stored last-run app version.

---

## Defect register

What the audit found, and how each was resolved. All twenty are fixed; the
behaviour above describes the result.

| ID  | Severity | Defect                                                                                                       | Resolution                                                                                                                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D3  | High     | No 429 / `rateLimitExceeded` / 5xx handling; only 401 was retried                                            | Backoff, jitter and `Retry-After` in `request()`, so every caller inherits it. 403 retried only for rate-limit reasons; 5xx only on idempotent methods |
| D7  | High     | Resume probe reporting "complete" skipped indexing → file orphaned on Drive while the transfer reported done | `probeSession()` returns the finished metadata and routes into a single shared `finalize()`                                                            |
| D5  | High     | `change.removed` hard-deleted managed nodes, defeating `missing_remote`                                      | Branch on `origin`; managed rows are flagged, mirrored rows deleted                                                                                    |
| D1  | High     | Post-reinstall users were never told a cloud backup existed                                                  | Home page detects "never backed up here, yet backups exist" and offers restore                                                                         |
| D16 | High     | An unreadable token store discarded _all_ accounts' tokens on the next write                                 | The bad file is moved aside; writes are write-then-rename                                                                                              |
| D9  | Medium   | Downloads renamed to final without length or md5 verification                                                | `verify()` checks both, deletes the partial and retries on mismatch; fsync before rename                                                               |
| D14 | Medium   | Any HTTP 400 triggered a destructive full rescan                                                             | Narrowed to 410 / `invalidPageToken`                                                                                                                   |
| D2  | Medium   | `orphaned` written, never read or cleared                                                                    | Cleared on reconnect; shown as "Unavailable" in the file list                                                                                          |
| D8  | Medium   | `NO_SPACE`/`NO_ACCOUNTS` retried 8 times pointlessly                                                         | Marked `retryable = false`                                                                                                                             |
| D13 | Medium   | Pinned-account uploads bypassed the allocator entirely                                                       | Pin passed as a preference through `pickAccountForUpload`; live sessions stay pinned                                                                   |
| D11 | Medium   | No connectivity or sleep awareness                                                                           | `powerMonitor` hooks plus an offline branch that parks work without consuming attempts                                                                 |
| D10 | Medium   | Auto-resume restarted transfers the user had paused                                                          | `paused_by` column distinguishes `user` from `system`                                                                                                  |
| D17 | Medium   | No schema-downgrade guard                                                                                    | `migrate()` refuses a newer `user_version`; restore checks the snapshot first                                                                          |
| D4  | Low      | `scan_cursor` was dead schema implying resumability                                                          | Checkpointed per page, carrying the original start time so resume doesn't prune its own work                                                           |
| D12 | Low      | `applyChange` not transactional                                                                              | Each page of changes applied in one transaction                                                                                                        |
| D6  | Low      | `migrate` escaped concurrency limits and byte reservation                                                    | Counted as both a read and a write against its target account                                                                                          |
| D15 | Low      | Thumbnail fetching had no concurrency cap                                                                    | Semaphore at 4                                                                                                                                         |
| D18 | Low      | Cancel leaked the partial file and the Drive session                                                         | `drive/cleanup.cjs`, called from `cancel()`                                                                                                            |
| D19 | Low      | Restore never verified a checksum, and the only copy lived inside the DB being restored                      | Checksum embedded in the snapshot filename and verified before decompression                                                                           |
| D20 | Cosmetic | `README.md` was the untouched starter template                                                               | Rewritten                                                                                                                                              |

### Verified after the fixes

Against the two live accounts: schema migrated to v3 · downgrade guard refuses a
future schema · upload indexed with matching md5 · download verified against the
source md5 with no partial left behind · pause set `paused_by='user'` and
survived an auto-resume, then completed through the probe path with **zero**
retry attempts consumed · backup written with an embedded checksum and parsed
back · hopeless upload failed immediately as non-retryable · full rescan of both
accounts idempotent (13 nodes → 13) with cursors cleared · change poller drained
with no errors · `integrity_check` ok · all eight pages render with no renderer
errors.
