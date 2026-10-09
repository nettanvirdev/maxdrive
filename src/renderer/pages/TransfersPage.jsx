import { Pause, Play, Upload, X } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/files/EmptyState";
import { runCommand } from "@/commands/dispatch";
import { TransferRow } from "@/components/transfers/TransferRow";
import { isActive, useTransfersStore } from "@/stores/useTransfersStore";

export function TransfersPage() {
  const { transfers, speeds } = useTransfersStore();

  const active = transfers.filter(isActive);
  const finished = transfers.filter((t) => !isActive(t));

  return (
    <PageShell
      title="Transfers"
      actions={
        <>
          {active.some((t) => t.state !== "paused") ? (
            <TextButton
              icon={Pause}
              label="Pause all"
              onClick={() => runCommand("job.pauseAll")}
            />
          ) : null}
          {active.some((t) => t.state === "paused") ? (
            <TextButton
              icon={Play}
              label="Resume all"
              onClick={() => runCommand("job.resumeAll")}
            />
          ) : null}
          {finished.length > 0 && (
            <TextButton
              icon={X}
              label="Clear finished"
              onClick={() => runCommand("job.clear")}
            />
          )}
        </>
      }
    >
      {transfers.length === 0 ? (
        <EmptyState
          icon={Upload}
          title="No transfers yet"
          description="Drop files anywhere in the window to upload. Transfers keep running in the background - you can close the window and they continue from the tray."
        />
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <Group title={`In progress (${active.length})`}>
              {active.map((t) => (
                <TransferRow key={t.id} transfer={t} bps={speeds[t.id]?.bps} />
              ))}
            </Group>
          )}
          {finished.length > 0 && (
            <Group title="Finished">
              {finished.map((t) => (
                <TransferRow key={t.id} transfer={t} />
              ))}
            </Group>
          )}
        </div>
      )}
    </PageShell>
  );
}

function Group({ title, children }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y divide-border rounded-lg border border-border">
        {children}
      </div>
    </section>
  );
}

function TextButton({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium text-primary transition-colors hover:bg-[var(--hover-overlay)]"
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
