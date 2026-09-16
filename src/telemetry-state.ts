import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import { writeOwnerJson } from "./config-dir";

/** Machine id + stored setting. Not in `credentials.json`, which `logout` deletes. */

const TelemetryStateSchema = z.object({
  deviceId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export interface TelemetryState {
  deviceId?: string;
  enabled: boolean;
}

/** No file ⇒ on by default. A file that exists but cannot be read or parsed ⇒
 *  OFF: it may hold an opt-out, and a privacy setting must fail closed. */
export async function loadTelemetryState(
  path: string,
): Promise<TelemetryState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { enabled: code === "ENOENT" || code === "ENOTDIR" };
  }
  try {
    const parsed = TelemetryStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { enabled: false };
    return {
      deviceId: parsed.data.deviceId,
      enabled: parsed.data.enabled ?? true,
    };
  } catch {
    return { enabled: false };
  }
}

export async function saveTelemetryState(
  path: string,
  state: TelemetryState,
): Promise<void> {
  // Staged write matters here: a truncated file reads as opted out.
  await writeOwnerJson(path, state);
}

/** Stores the machine id, and only when the setting still says enabled: this is
 *  a read-modify-write, so a `telemetry disable` landing in between would
 *  otherwise be overwritten by the stale `enabled: true` read. */
export async function persistDeviceId(
  path: string,
  deviceId: string,
): Promise<void> {
  const current = await loadTelemetryState(path);
  if (!current.enabled) return;
  await saveTelemetryState(path, { ...current, deviceId });
}

/** Keeps the machine id, so toggling off and on is not a new machine. */
export async function setTelemetryEnabled(
  path: string,
  enabled: boolean,
): Promise<TelemetryState> {
  const current = await loadTelemetryState(path);
  const next: TelemetryState = { ...current, enabled };
  await saveTelemetryState(path, next);
  return next;
}

export async function clearTelemetryState(path: string): Promise<void> {
  await rm(path, { force: true });
}
