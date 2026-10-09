import { COMMAND_MAP, isAvailable } from "./registry";
import { buildContext } from "./context";
import { toast } from "@/stores/useToastStore";
import { useOverlayStore } from "@/stores/useOverlayStore";

/**
 * The one place a command is executed, whatever triggered it.
 *
 * Errors surface as a toast here rather than in each caller, which is why the
 * menus and the palette can simply call `runCommand(id)` without their own
 * try/catch - the duplicated `run()` helpers in ItemMenu and FileActions
 * existed only to do this.
 */
export async function runCommand(id, ctx = buildContext()) {
  const command = COMMAND_MAP.get(id);
  if (!command) return false;
  if (!isAvailable(command, ctx)) return false;

  try {
    await command.run(ctx);
    return true;
  } catch (err) {
    // A vault-mode file locked under us: offer the way in, not a dead end.
    if (err?.code === "SEAL_LOCKED")
      useOverlayStore.getState().openDialog("sealUnlock");
    else toast.error(err?.message || `${command.title} failed`);
    return false;
  }
}

/**
 * Finds the command a chord should run right now.
 *
 * Walks the bindings in priority order and returns the first whose command is
 * actually available, so a chord claimed by several commands resolves by
 * context rather than by whichever registered last.
 */
export function resolveChord(bindings, chord, ctx, { overlayOpen }) {
  for (const binding of bindings) {
    if (binding.chord !== chord) continue;
    // Page shortcuts stand down while a dialog or the palette is open.
    if (overlayOpen && binding.scope !== "always") continue;
    const command = COMMAND_MAP.get(binding.command);
    if (isAvailable(command, ctx)) return binding;
  }
  return null;
}
