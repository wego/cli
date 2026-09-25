import { z } from "zod";

/**
 * The recorded ring an install follows (foundations#74 rung 3).
 *
 * Self-update compares checksums, not versions (`update.ts`), so the ring pointer
 * is the whole policy and has to be a fact on the machine rather than baked in at
 * build time. A baked pointer keeps a binary updating from the channel it was
 * built for, and leaves nothing to move when an install is promoted between
 * rings.
 *
 * The installer records the ring (`apps/api` `renderInstallScript` writes
 * `~/.config/<scope>/install.json`) and `update` follows it, so re-pointing an
 * install is a file write rather than a rebuild.
 *
 * Fail closed: no record, an unreadable one, or one missing either field is a
 * refusal, never a fallback to a guessed pointer.
 */

/** Under `~/.config/<scope>/` (`config.ts` `defaultInstallRecordPath`). The
 *  installer script writes the same leaf. */
export const INSTALL_RECORD_FILE = "install.json";

/**
 * One flat pointer segment. A shape rather than a closed set, so a binary can
 * follow a ring added after it shipped. Path separators, `..`, spaces and
 * uppercase are rejected, so a recorded ring is always safe to interpolate into a
 * URL or a message.
 */
const RING_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const InstallRecordSchema = z.object({
  ring: z
    .string()
    .regex(RING_NAME, "ring must be one flat lowercase pointer name"),
  // The endpoint that served this install (`<api>/install`). `update` appends
  // that route's `?dl=` marker, so the path must be `/install`, and a URL that
  // already carries a query or fragment is rejected rather than mangled. Any
  // other path would fetch from an endpoint the deploy never serves as `?dl=`.
  installUrl: z.string().superRefine((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `installUrl is not a URL: ${raw}`,
      });
      return;
    }
    if (url.search || url.hash) {
      ctx.addIssue({
        code: "custom",
        message: "installUrl must carry no query string or fragment",
      });
    }
    // Dot segments are rejected, not resolved. `new URL()` normalizes `..`, so
    // `/install/extra/..` and `/foo/../install/` both present as `/install/`
    // while the raw string, which a consumer might build a URL from, still
    // carries the traversal. The installer never writes one, so a record that has
    // one was edited by hand or by something hostile. Read the path off the raw
    // string because `url.pathname` has already resolved them away.
    const afterScheme = raw.slice(raw.indexOf("://") + 3);
    const firstSlash = afterScheme.indexOf("/");
    const rawPath = firstSlash === -1 ? "" : afterScheme.slice(firstSlash);
    if (rawPath.split("/").some((seg) => seg === "." || seg === "..")) {
      ctx.addIssue({
        code: "custom",
        message: "installUrl must carry no `.` or `..` path segment",
      });
    }
    // `url.origin` drops credentials, so canonicalizing would strip them
    // silently. Refuse instead.
    if (url.username || url.password) {
      ctx.addIssue({
        code: "custom",
        message: "installUrl must carry no credentials",
      });
    }
    if (url.pathname !== "/install" && url.pathname !== "/install/") {
      ctx.addIssue({
        code: "custom",
        message: "installUrl must be the deploy's /install endpoint",
      });
    }
    // `/install/` is accepted and canonicalized by the transform below. It names
    // the same endpoint, so refusing it would break `update` and the notice over
    // a slash the user cannot tell apart. Canonicalizing a URL is not guessing a
    // ring.
  }),
});

/** Canonicalizes `installUrl` so exactly one spelling of the endpoint reaches any
 *  consumer. Rebuilt from the parsed URL (`origin` plus the fixed path), never by
 *  editing the raw string: the refinement validates the parsed view, and a
 *  transform over the raw text would be reading a different value (a `..`
 *  segment once slipped through that gap). */
const CanonicalInstallRecordSchema = InstallRecordSchema.transform((r) => ({
  ...r,
  installUrl: `${new URL(r.installUrl).origin}/install`,
}));

export type InstallRecord = z.infer<typeof CanonicalInstallRecordSchema>;

/**
 * One `null` for absent, not JSON, or malformed, because the caller refuses on
 * all of them.
 */
export function parseInstallRecord(
  raw: string | null | undefined,
): InstallRecord | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = CanonicalInstallRecordSchema.safeParse(json);
  return result.success ? result.data : null;
}

export interface RingSource {
  ring: string;
  /** The recorded install endpoint, trailing slashes stripped. */
  base: string;
}

export type RingDecision =
  | ({ ok: true } & RingSource)
  | { ok: false; message: string };

/**
 * The refusal names the record's path, so the user can see what is missing, and
 * the reinstall line, which is the only way to obtain a record.
 */
export function followRecordedRing(args: {
  record: InstallRecord | null;
  recordPath: string;
  reinstallHint: string;
}): RingDecision {
  const { record, recordPath, reinstallHint } = args;
  if (!record) {
    return {
      ok: false,
      message:
        `no release ring recorded at ${recordPath} – refusing to guess which ring to update from.\n` +
        `Reinstall to record it:\n  ${reinstallHint}`,
    };
  }
  return {
    ok: true,
    ring: record.ring,
    base: stripTrailingSlashes(record.installUrl),
  };
}

/** A loop rather than `/\/+$/`, which SonarQube flags as `typescript:S5852`
 *  (super-linear backtracking). The parsed record is already canonical, so this
 *  only guards a hand-built record. Exported so `version-notice.ts` does not grow
 *  a second copy. `apps/api`'s `installRoute` keeps its own because the two apps
 *  share no code. */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/**
 * The agent skill base for a followed ring: the build-pinned store `origin` plus
 * the ring recorded on this machine.
 *
 *  - The origin is a trust anchor. A wrong origin serves the body and the
 *    `SHA256SUMS` beside it, so a checksum verify cannot detect it. It must not
 *    be influenceable at run time, so it is baked and pinned to the store's host
 *    family (`release-config.ts`).
 *  - The ring is policy. A promote moves a pointer over the same bytes (`cli/next`
 *    and `cli/stable` are byte-identical), so a ring compiled into the binary is
 *    wrong on one side of every promote (issue #1751).
 *
 * `undefined` when either half is missing or the ring is malformed; never a
 * guessed default. Any well-formed ring composes, including an unknown one: a
 * ring with nothing published 404s, which is safer than an allowlist that would
 * block rings added later.
 */
export function skillBaseForRing(
  origin: string | undefined,
  ring: string | undefined,
): string | undefined {
  if (!origin || !ring || !RING_NAME.test(ring)) return undefined;
  return `${stripTrailingSlashes(origin)}/skill/${ring}`;
}

/**
 * Through the recorded install endpoint's `?dl=` branch (`apps/api`
 * `installRoute`), the same first-party host the installer used, so the release
 * store's hostname stays server-side.
 *
 * `ring` is required (foundations#74 rung 4). A bare `?dl=` resolves against the
 * deploy's configured channel, so a `next` or `edge` install would silently fetch
 * another pointer's bytes, and since self-update decides on a checksum difference
 * alone, that swap would be undetectable. Required in the signature so the
 * compiler keeps a new call site from omitting it. A ring with nothing published
 * 404s and `update` refuses; it never serves another ring's bytes.
 */
export function ringAssetUrl(
  base: string,
  asset: string,
  ring: string,
): string {
  return `${base}?dl=${encodeURIComponent(asset)}&ring=${encodeURIComponent(ring)}`;
}

/**
 * A ring's signed build record (foundations#74 rung 9). `&sig=1` makes the deploy
 * resolve the name against the record prefix (`cli-sig/<ring>`) instead of the
 * download prefix (`cli/<ring>`). The prefixes are separate because a record
 * stored beside the manifest it signs would fall to the same store write it
 * exists to detect.
 */
export function ringRecordUrl(
  base: string,
  asset: string,
  ring: string,
): string {
  return `${ringAssetUrl(base, asset, ring)}&sig=1`;
}
