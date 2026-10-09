import { useState } from "react";
import { DatabaseBackup, FolderOpen } from "lucide-react";
import {
  Modal,
  ModalButton,
  ModalError,
  ModalSection,
  inputClass,
} from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { toast } from "@/stores/useToastStore";

const api = () => window.maxdrive;

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Human summary shown on the set card ("Daily at 02:00", "Manual only"…). */
export function describeSchedule(schedule) {
  if (!schedule?.freq) return "Manual only";
  if (schedule.freq === "interval") {
    const mins = Number(schedule.intervalMinutes) || 360;
    return mins % 60 === 0 ? `Every ${mins / 60} h` : `Every ${mins} min`;
  }
  const time = schedule.time || "02:00";
  if (schedule.freq === "daily") return `Daily at ${time}`;
  if (schedule.freq === "weekly")
    return `${DAY_NAMES[schedule.dayOfWeek ?? 0]}s at ${time}`;
  if (schedule.freq === "monthly")
    return `Monthly on day ${schedule.dayOfMonth ?? 1} at ${time}`;
  return "Manual only";
}

function ChipInput({ label, hint, values, onChange, placeholder }) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (!values.includes(value)) onChange([...values, value]);
    setDraft("");
  };

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <p className="text-sm text-foreground">{label}</p>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="flex items-center gap-1 rounded-full bg-drive-variant px-2.5 py-1 text-xs text-foreground"
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((v) => v !== value))}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={placeholder}
          className="h-7 min-w-[110px] flex-1 rounded-full border border-dashed border-border bg-transparent px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
      </div>
    </div>
  );
}

function RadioRow({ options, value, onChange }) {
  return (
    <div className="flex gap-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 ease-standard ${
            value === option.value
              ? "border-primary bg-[var(--selected-overlay)]"
              : "border-border hover:bg-[var(--hover-overlay)]"
          }`}
        >
          <p className="text-sm font-medium text-foreground">{option.label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{option.hint}</p>
        </button>
      ))}
    </div>
  );
}

const selectClass =
  "h-9 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-primary";

/**
 * Create/edit a backup set. On create the folder is picked first; on edit the
 * root and mode are fixed (moving a set's root or format mid-life would orphan
 * its cloud state).
 */
export function BackupSetDialog({ set, accounts = [], onClose, onSaved }) {
  const editing = Boolean(set);
  const [localRoot, setLocalRoot] = useState(set?.local_root || "");
  const [name, setName] = useState(set?.name || "");
  const [mode, setMode] = useState(set?.mode || "mirror");
  const [deletionPolicy, setDeletionPolicy] = useState(
    set?.deletion_policy || "trash",
  );
  const [primaryAccountId, setPrimaryAccountId] = useState(
    set?.primary_account_id || "",
  );
  const [ignoreDirs, setIgnoreDirs] = useState(
    set?.rules?.ignoreDirs ?? ["node_modules", ".git", ".github"],
  );
  const [excludeExts, setExcludeExts] = useState(
    set?.rules?.excludeExts ?? [".env"],
  );
  const [includeExts, setIncludeExts] = useState(set?.rules?.includeExts ?? []);
  const [freq, setFreq] = useState(set?.schedule?.freq || "daily");
  const [time, setTime] = useState(set?.schedule?.time || "02:00");
  const [dayOfWeek, setDayOfWeek] = useState(set?.schedule?.dayOfWeek ?? 0);
  const [dayOfMonth, setDayOfMonth] = useState(set?.schedule?.dayOfMonth ?? 1);
  const [intervalMinutes, setIntervalMinutes] = useState(
    set?.schedule?.intervalMinutes ?? 360,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pickFolder = () => {
    api()
      .dialog.pickFolder()
      .then((picked) => {
        if (!picked) return;
        setLocalRoot(picked);
        if (!name) setName(picked.split(/[\\/]/).filter(Boolean).pop() || "");
      })
      .catch(() => {});
  };

  const save = () => {
    if (!localRoot) {
      setError("Choose a folder to back up.");
      return;
    }
    setBusy(true);
    setError(null);

    const schedule =
      freq === "manual"
        ? {}
        : {
            freq,
            ...(freq === "interval"
              ? { intervalMinutes: Number(intervalMinutes) || 360 }
              : { time }),
            ...(freq === "weekly" ? { dayOfWeek: Number(dayOfWeek) } : {}),
            ...(freq === "monthly"
              ? { dayOfMonth: Number(dayOfMonth) || 1 }
              : {}),
          };
    const rules = {
      ignoreDirs,
      excludeExts,
      includeExts: includeExts.length ? includeExts : null,
    };

    const request = editing
      ? api().localBackup.updateSet(set.id, {
          name,
          deletionPolicy,
          rules,
          schedule,
          primaryAccountId: primaryAccountId || null,
        })
      : api().localBackup.createSet({
          name,
          localRoot,
          mode,
          deletionPolicy,
          rules,
          schedule,
          primaryAccountId: primaryAccountId || null,
        });

    request
      .then((result) => {
        if (result?.overlaps?.length) {
          toast.info(`Heads up: this folder overlaps “${result.overlaps[0]}”.`);
        }
        toast.success(editing ? "Backup updated." : "Backup created.");
        onSaved();
      })
      .catch((err) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <Modal
      title={editing ? `Edit “${set.name}”` : "Back up a folder"}
      icon={<DatabaseBackup className="h-5 w-5 text-primary" />}
      subtitle={
        editing
          ? set.local_root
          : "One-way: local changes flow to Drive, never back."
      }
      width={560}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton variant="primary" busy={busy} onClick={save}>
            {editing ? "Save changes" : "Start backing up"}
          </ModalButton>
        </>
      }
    >
      {!editing ? (
        <div className="flex items-center gap-2">
          <input
            value={localRoot}
            readOnly
            placeholder="No folder chosen"
            className={`${inputClass} cursor-default`}
            onClick={pickFolder}
          />
          <ModalButton icon={FolderOpen} onClick={pickFolder}>
            Browse
          </ModalButton>
        </div>
      ) : null}

      <div className="mt-3">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Name</p>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Backup name"
          className={inputClass}
        />
      </div>

      {!editing ? (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Storage format
          </p>
          <RadioRow
            value={mode}
            onChange={setMode}
            options={[
              {
                value: "mirror",
                label: "Mirror (recommended)",
                hint: "Folder structure kept in Drive. Only changed files re-upload; restore any single file.",
              },
              {
                value: "archive",
                label: "Zip archive",
                hint: "Each run uploads compressed zip parts that can span accounts. Best for many tiny files.",
              },
            ]}
          />
        </div>
      ) : null}

      <div className="mt-4">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          When a file is deleted locally
        </p>
        <RadioRow
          value={deletionPolicy}
          onChange={setDeletionPolicy}
          options={[
            {
              value: "trash",
              label: "Move cloud copy to trash",
              hint: "Recoverable for 30 days, then Google purges it. Storage is reclaimed.",
            },
            {
              value: "keep",
              label: "Keep cloud copy forever",
              hint: "Deleted files stay restorable until you remove them yourself.",
            },
          ]}
        />
      </div>

      <div className="mt-4">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          Schedule
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={freq}
            onChange={setFreq}
            aria-label="Backup frequency"
            options={[
              { value: "manual", label: "Manual only" },
              { value: "interval", label: "Every few hours" },
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
            ]}
          />
          {freq === "weekly" ? (
            <Select
              value={dayOfWeek}
              onChange={setDayOfWeek}
              aria-label="Day of week"
              options={DAY_NAMES.map((day, index) => ({
                value: index,
                label: day,
              }))}
            />
          ) : null}
          {freq === "monthly" ? (
            <input
              type="number"
              min={1}
              max={31}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
              className={`${selectClass} w-20`}
              aria-label="Day of month"
            />
          ) : null}
          {freq === "daily" || freq === "weekly" || freq === "monthly" ? (
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={selectClass}
              aria-label="Time of day"
            />
          ) : null}
          {freq === "interval" ? (
            <Select
              value={intervalMinutes}
              onChange={setIntervalMinutes}
              aria-label="Backup interval"
              options={[
                { value: 60, label: "Every hour" },
                { value: 180, label: "Every 3 hours" },
                { value: 360, label: "Every 6 hours" },
                { value: 720, label: "Every 12 hours" },
              ]}
            />
          ) : null}
        </div>
      </div>

      {accounts.length > 1 ? (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            Preferred account
          </p>
          <Select
            value={primaryAccountId}
            onChange={setPrimaryAccountId}
            aria-label="Preferred account"
            className="w-full"
            options={[
              { value: "", label: "Automatic (most free space)" },
              ...accounts.map((account) => ({
                value: account.id,
                label: account.email,
              })),
            ]}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Files spill to other accounts automatically when this one fills up.
          </p>
        </div>
      ) : null}

      <ModalSection title="Rules" className="px-4 py-1 divide-y divide-border">
        <ChipInput
          label="Ignored folders"
          hint="Skipped entirely, at any depth."
          values={ignoreDirs}
          onChange={setIgnoreDirs}
          placeholder="Add folder name…"
        />
        <ChipInput
          label="Excluded file types"
          hint="Never backed up - secrets like .env belong here."
          values={excludeExts}
          onChange={setExcludeExts}
          placeholder="Add extension…"
        />
        <ChipInput
          label="Only these file types"
          hint="Leave empty to back up everything not excluded."
          values={includeExts}
          onChange={setIncludeExts}
          placeholder="e.g. .docx"
        />
      </ModalSection>

      <ModalError>{error}</ModalError>
    </Modal>
  );
}
