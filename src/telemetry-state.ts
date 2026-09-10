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

/**
 * Carry a PRE-RENAME opt-out forward, once.
 *
 * Making the command name the config scope moved this file from the flavor-keyed
 * directory to the name-keyed one. Every other file that moved fails in a
 * direction that is merely inconvenient and self-announcing: the install looks
 * logged out, or `update` refuses and names the old directory. This one would fail
 * the other way — no file means ON — and silently send data the user asked us not
 * to send. So it is the one that gets a fallback instead of a diagnostic.
 *
 * Only the OPT-OUT travels, never the device id: inheriting an id would merge two
 * installs into one machine identity, while re-minting one is harmless.
 *
 * A one-time WRITE, not a read-time fallback, because the setting is read through
 * a dozen paths and written through two: `persistDeviceId` reads this file to
 * decide whether it may store an id, so a fallback that only existed on the read
 * side would let the next id write stamp `enabled: true` over the inherited
 * opt-out. Seeding the boolean once means every existing path — `telemetry
 * status`, the sender, the uninstall teardown — sees the same stored answer.
 *
 * No-ops unless the new file is ABSENT and the legacy file says opted out, so it
 * can never overwrite a live setting and never runs twice. An unreadable legacy
 * file reads as opted out (`loadTelemetryState` fails closed) and is therefore
 * inherited as one — the safe direction, and the same answer that file would have
 * given in place.
 */
export async function inheritTelemetryOptOut(
  path: string,
  legacyPath: string | undefined,
): Promise<boolean> {
  if (!legacyPath || legacyPath === path) return false;
  // Only an ABSENT file may be seeded. A present-but-unreadable one already reads
  // as opted out, and writing over it could destroy a setting we cannot see.
  try {
    await readFile(path, "utf8");
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return false;
  }
  if ((await loadTelemetryState(legacyPath)).enabled) return false;
  await saveTelemetryState(path, { enabled: false });
  return true;
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
