import { randomUUID } from "node:crypto";
import { chmod, link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ensureOwnerDir, writeOwnerJson } from "./config-dir";

/** `~/.config/<scope>/session.json`: the id that groups one working stretch. */

export const SESSION_INACTIVITY_MS = 30 * 60 * 1000;
export const SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the API's own guard, which logs a warning for every non-uuid it gets. */
export function isUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_PATTERN.test(value);
}

// Same guard on the way in: a non-uuid id would be reused forever and never expire.
const SessionSchema = z.object({
  id: z.string().refine(isUuid),
  createdAt: z.number(),
  lastSeenAt: z.number(),
});

export interface CliSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface ResolveSessionOptions {
  path: string;
  now?: number;
  inactivityMs?: number;
  maxLifetimeMs?: number;
}

/** Unreadable, absent, corrupt, and non-uuid all mean: start a new session. */
async function readSession(path: string): Promise<CliSession | undefined> {
  try {
    const parsed = SessionSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A backwards clock expires too, rather than pinning the session open. */
function isLive(
  session: CliSession,
  now: number,
  inactivityMs: number,
  maxLifetimeMs: number,
): boolean {
  const idle = now - session.lastSeenAt;
  const age = now - session.createdAt;
  return idle >= 0 && idle <= inactivityMs && age >= 0 && age <= maxLifetimeMs;
}

const REPLACE_ATTEMPTS = 50;
const REPLACE_BACKOFF_MS = 2;

/** Replace an EXPIRED record, serialized on a lock so a stale read cannot evict a
 *  session another process just published. `link` is the exclusion primitive: it
 *  fails when the name exists, so exactly one holder replaces and the rest re-read
 *  and adopt. A holder that dies leaves the lock behind, which costs a split
 *  session on the next start, never a deadlock. */
async function replaceExpired(
  path: string,
  tmp: string,
  minted: CliSession,
  live: (session: CliSession) => boolean,
): Promise<CliSession> {
  const lock = `${path}.claim`;
  for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
    const current = await readSession(path);
    if (current && live(current)) return current;
    try {
      await link(tmp, lock);
    } catch {
      // Someone else is replacing: let them finish, then adopt what they wrote.
      await new Promise((r) => setTimeout(r, REPLACE_BACKOFF_MS));
      continue;
    }
    try {
      const held = await readSession(path);
      if (held && live(held)) return held;
      await rename(tmp, path);
      return minted;
    } finally {
      await rm(lock, { force: true }).catch(() => {});
    }
  }
  return minted;
}

/** Publish a minted session and return whichever id is really on disk: `link`
 *  fails if the name exists, so simultaneous first runs adopt one id instead of
 *  splitting the funnel. Nothing here ever unlinks a live record. */
async function claim(
  path: string,
  minted: CliSession,
  live: (session: CliSession) => boolean,
): Promise<CliSession> {
  // Unique per call, not per pid: two resolves in one process must not collide.
  const tmp = `${path}.${randomUUID()}.new`;
  try {
    await ensureOwnerDir(dirname(path));
    await writeFile(tmp, `${JSON.stringify(minted, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(tmp, 0o600);
    try {
      await link(tmp, path);
      return minted;
    } catch {
      return await replaceExpired(path, tmp, minted, live);
    }
  } catch {
    return minted;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Resolve ONCE per invocation: a command issues many requests, this writes a file. */
export async function resolveSession(
  opts: ResolveSessionOptions,
): Promise<CliSession> {
  const now = opts.now ?? Date.now();
  const inactivityMs = opts.inactivityMs ?? SESSION_INACTIVITY_MS;
  const maxLifetimeMs = opts.maxLifetimeMs ?? SESSION_MAX_LIFETIME_MS;
  const live = (session: CliSession) =>
    isLive(session, now, inactivityMs, maxLifetimeMs);
  const existing = await readSession(opts.path);
  if (existing && live(existing)) {
    const touched = { ...existing, lastSeenAt: now };
    // Overwrite is safe: the id is unchanged, so a concurrent toucher agrees.
    await writeOwnerJson(opts.path, touched).catch(() => {});
    return touched;
  }
  return claim(
    opts.path,
    { id: randomUUID(), createdAt: now, lastSeenAt: now },
    live,
  );
}

export async function clearSession(path: string): Promise<void> {
  await rm(path, { force: true });
}
