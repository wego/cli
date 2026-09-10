import { z } from "zod";
import { EXIT } from "./error-report";
import {
  TELEMETRY_EVENT,
  TELEMETRY_HOST,
  TELEMETRY_SENDER_COMMAND,
} from "./telemetry";

/** Delivery: the POST costs ~750ms and a spawn ~20ms, so a detached child sends it. */

export const SENDER_TIMEOUT_MS = 10_000;
export const INLINE_TIMEOUT_MS = 2_000;

function captureUrl(host: string): string {
  return `${host.replace(/\/+$/, "")}/i/v0/e/`;
}

/** Parsed, not cast: the payload arrives on the child's stdin, or in argv on
 *  the inline path — either way it is untrusted input crossing a boundary. */
const SenderPayloadSchema = z.object({
  event: z.literal(TELEMETRY_EVENT),
  distinct_id: z.string().min(1),
  timestamp: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
});

export type TelemetryPayload = z.infer<typeof SenderPayloadSchema>;

export interface PostTelemetryDeps {
  posthogKey: string;
  host?: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

/** Exactly one attempt, no retry. */
export async function postTelemetryEvent(
  event: TelemetryPayload,
  deps: PostTelemetryDeps,
): Promise<boolean> {
  try {
    const response = await deps.fetch(captureUrl(deps.host ?? TELEMETRY_HOST), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: deps.posthogKey, ...event }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? SENDER_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface TelemetrySenderDeps {
  posthogKey?: string;
  host?: string;
  fetch: typeof fetch;
  timeoutMs?: number;
  /** Reads the payload when argv carries none — the detached child's stdin. */
  readStdin?: () => Promise<string>;
  /** The child re-derives identity from its own credentials and state file, so a
   *  hand-run `wego send-telemetry '<payload>'` cannot attribute events to
   *  another account. Absent ⇒ the payload's own values are used (tests). */
  resolveIdentity?: () => Promise<{ distinctId: string; deviceId: string }>;
}

/** The hidden `send-telemetry <payload>` subcommand: always exits 0, prints nothing. */
export async function runTelemetrySender(
  args: readonly string[],
  deps: TelemetrySenderDeps,
): Promise<number> {
  if (!deps.posthogKey) return EXIT.OK;
  // argv form is the inline path (Windows, or a deleted binary); the detached
  // child reads stdin instead, so the payload never shows up in `ps`.
  const raw = args[0] ?? (await deps.readStdin?.().catch(() => undefined));
  if (raw === undefined || raw === "") return EXIT.OK;
  let parsed: TelemetryPayload;
  try {
    const result = SenderPayloadSchema.safeParse(JSON.parse(raw));
    if (!result.success) return EXIT.OK;
    parsed = result.data;
  } catch {
    return EXIT.OK;
  }
  const identity = await deps.resolveIdentity?.().catch(() => undefined);
  const event = identity ? withIdentity(parsed, identity) : parsed;
  await postTelemetryEvent(event, {
    posthogKey: deps.posthogKey,
    host: deps.host,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs,
  });
  return EXIT.OK;
}

/** Re-key an event on this machine's own identity. The anonymous-tier marker is
 *  recomputed with it: leaving the parent's value would pair a logged-in
 *  `distinct_id` with person-processing suppressed (or the reverse) when the auth
 *  state changed between the two reads. */
function withIdentity(
  event: TelemetryPayload,
  identity: { distinctId: string; deviceId: string },
): TelemetryPayload {
  const properties: Record<string, unknown> = {
    ...event.properties,
    device_id: identity.deviceId,
  };
  const anonymous = identity.distinctId === identity.deviceId;
  if (anonymous) {
    properties.$process_person_profile = false;
  } else {
    delete properties.$process_person_profile;
  }
  return { ...event, distinct_id: identity.distinctId, properties };
}

export interface SpawnSenderDeps {
  execPath: string;
  spawn: (command: string[]) => {
    stdin: { write: (data: string) => unknown; end: () => unknown };
    unref: () => void;
  };
}

/** Neither the key nor the payload is passed in argv: the key is re-derived by
 *  the child, and the payload goes down its stdin, so `ps` shows neither. The
 *  flush must be awaited (~1ms on a local pipe) or exiting drops the buffer. */
export async function spawnTelemetrySender(
  payload: string,
  deps: SpawnSenderDeps,
): Promise<void> {
  try {
    const child = deps.spawn([deps.execPath, TELEMETRY_SENDER_COMMAND]);
    child.stdin.write(payload);
    await child.stdin.end();
    child.unref();
  } catch {
    /* ignore */
  }
}
