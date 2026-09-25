import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSession,
  isUuid,
  resolveSession,
  SESSION_INACTIVITY_MS,
  SESSION_MAX_LIFETIME_MS,
} from "./session";

/**
 * The session id groups one working stretch, so the API's events and the CLI's
 * own `cli_command_ran` land in the same PostHog session. Every expiry rule is
 * exercised against an injected `now`, never a real clock, so the 24h bound is
 * testable at all.
 */

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wego-session-"));
  path = join(dir, "session.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const T0 = 1_700_000_000_000;

describe("resolveSession", () => {
  it("mints and persists a uuid when there is no file", async () => {
    const session = await resolveSession({ path, now: T0 });

    expect(isUuid(session.id)).toBe(true);
    expect(session.createdAt).toBe(T0);
    expect(session.lastSeenAt).toBe(T0);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(session);
  });

  it("reuses the id inside both windows and advances lastSeenAt", async () => {
    const first = await resolveSession({ path, now: T0 });
    const second = await resolveSession({ path, now: T0 + 60_000 });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(T0);
    expect(second.lastSeenAt).toBe(T0 + 60_000);
  });

  it("keeps one session across a gap just under the idle bound", async () => {
    const first = await resolveSession({ path, now: T0 });
    const second = await resolveSession({
      path,
      now: T0 + SESSION_INACTIVITY_MS,
    });

    expect(second.id).toBe(first.id);
  });

  it("starts a new session once the idle bound is passed", async () => {
    const first = await resolveSession({ path, now: T0 });
    const second = await resolveSession({
      path,
      now: T0 + SESSION_INACTIVITY_MS + 1,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.createdAt).toBe(T0 + SESSION_INACTIVITY_MS + 1);
  });

  it("starts a new session at the max lifetime even while still active", async () => {
    const first = await resolveSession({ path, now: T0 });
    // Touched well inside the idle bound throughout, so only the age one can trip.
    const step = SESSION_INACTIVITY_MS / 2;
    let last = first;
    for (let t = T0 + step; t <= T0 + SESSION_MAX_LIFETIME_MS; t += step) {
      last = await resolveSession({ path, now: t });
    }
    expect(last.id).toBe(first.id);

    const past = await resolveSession({
      path,
      now: T0 + SESSION_MAX_LIFETIME_MS + 60_000,
    });
    expect(past.id).not.toBe(first.id);
  });

  it("expires on a backwards clock rather than pinning the session open", async () => {
    const first = await resolveSession({ path, now: T0 });
    const second = await resolveSession({ path, now: T0 - 1 });

    expect(second.id).not.toBe(first.id);
  });

  it("replaces a corrupt file instead of throwing", async () => {
    await writeFile(path, "{ not json");

    const session = await resolveSession({ path, now: T0 });

    expect(isUuid(session.id)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).id).toBe(session.id);
  });

  it("replaces a well-formed file that is missing the timestamps", async () => {
    await writeFile(path, JSON.stringify({ id: "abc" }));

    const session = await resolveSession({ path, now: T0 });

    expect(session.id).not.toBe("abc");
  });

  it("replaces a non-uuid id rather than sending one the API rejects", async () => {
    // Otherwise it is reused forever: each run refreshes lastSeenAt, so the
    // expiry never fires, and the API warns on every request.
    await writeFile(
      path,
      JSON.stringify({ id: "abc", createdAt: T0, lastSeenAt: T0 }),
    );

    const session = await resolveSession({ path, now: T0 + 1000 });

    expect(session.id).not.toBe("abc");
    expect(isUuid(session.id)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).id).toBe(session.id);
  });

  it("gives concurrent first-runs ONE session instead of splitting the funnel", async () => {
    // Two agents starting together on a machine with no live session.
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => resolveSession({ path, now: T0 })),
    );

    const ids = new Set(runs.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8")).id).toBe(
      runs[0]?.id as string,
    );
  });

  it("gives concurrent runs ONE session after the old one expired too", async () => {
    await resolveSession({ path, now: T0 });
    const later = T0 + SESSION_INACTIVITY_MS + 1;

    const runs = await Promise.all(
      Array.from({ length: 8 }, () => resolveSession({ path, now: later })),
    );

    expect(new Set(runs.map((r) => r.id)).size).toBe(1);
  });

  it("still returns an id when the path cannot be written", async () => {
    // A file where the directory should be: every write below it fails.
    const blocked = join(dir, "wall");
    await writeFile(blocked, "");

    const session = await resolveSession({
      path: join(blocked, "session.json"),
      now: T0,
    });

    expect(isUuid(session.id)).toBe(true);
  });

  it("writes owner-only, like the credentials beside it", async () => {
    await resolveSession({ path, now: T0 });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("clearSession", () => {
  it("removes the file", async () => {
    await resolveSession({ path, now: T0 });
    await clearSession(path);

    expect(await stat(path).catch(() => null)).toBeNull();
  });

  it("is a no-op when there is nothing to remove", async () => {
    await clearSession(path);
    expect(await stat(path).catch(() => null)).toBeNull();
  });
});

describe("isUuid", () => {
  it("accepts a v4 and a v7 uuid, in either case", () => {
    expect(isUuid("b05d7226-701f-4892-abc3-dd92727b5683")).toBe(true);
    expect(isUuid("019fb66d-2c3f-79a2-94f2-ec5b4af93211")).toBe(true);
    expect(isUuid("B05D7226-701F-4892-ABC3-DD92727B5683")).toBe(true);
  });

  it("rejects the device-id sentinels, which the API would warn about", () => {
    expect(isUuid("ephemeral")).toBe(false);
    expect(isUuid("unassigned")).toBe(false);
  });

  it("rejects an absent or malformed value", () => {
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("b05d7226701f4892abc3dd92727b5683")).toBe(false);
    expect(isUuid("b05d7226-701f-4892-abc3-dd92727b5683-extra")).toBe(false);
  });
});
