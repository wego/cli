import { z } from "zod";

/**
 * The recorded ring an install follows (foundations#74 rung 3).
 *
 * `wego update` used to fetch from a base BAKED into the binary
 * (`WEGO_BUILD_DOWNLOAD_BASE_URL`), so which pointer a machine received bytes
 * from was decided at build time, and nothing on the machine could say which one
 * it had chosen. Two consequences the ring model cannot live with: a binary that
 * travels between channels keeps updating from the channel it was BUILT for, and
 * there is no record to move when an install is promoted from one ring to
 * another. Since self-update compares CHECKSUMS, not versions (`update.ts`), the
 * pointer is the whole policy — so the pointer has to be a fact on the machine.
 *
 * So the INSTALLER records the ring (`apps/api` `renderInstallScript` writes
 * `~/.config/<scope>/install.json`) and `update` follows that record. The record
 * is config, not build config: re-pointing an install becomes a file write rather
 * than a rebuild, which is the premise every ring-shaped rung above rests on.
 *
 * Fail closed. No record, an unreadable one, or one missing either field is a
 * REFUSAL — never a fallback to a guessed pointer. Quietly picking a ring is the
 * exact drift this rung removes.
 */

/** The record's file name under `~/.config/<scope>/` (`config.ts`
 *  `defaultInstallRecordPath`). The installer script writes the same leaf. */
export const INSTALL_RECORD_FILE = "install.json";

/**
 * One flat pointer segment — `latest` / `staging` today, `edge` / `next` /
 * `stable` once those prefixes exist. Deliberately a SHAPE, not a closed set:
 * this rung owns "follow what was recorded", not the ring vocabulary, and a
 * binary that refused a well-formed name it had never heard of could not follow a
 * pointer added after it shipped. Path separators, `..`, spaces and uppercase are
 * rejected, so a recorded ring is always safe to interpolate into a URL or a
 * message.
 */
const RING_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const InstallRecordSchema = z.object({
  ring: z
    .string()
    .regex(RING_NAME, "ring must be one flat lowercase pointer name"),
  // The endpoint that served this install (`<api>/install`). `update` appends
  // that route's own `?dl=` marker, so the record must name that exact route: the
  // path is required to be `/install`, and a URL that already carries a query or a
  // fragment is rejected rather than silently mangled. Anything else (a bare host,
  // a `/other` path) would send `update` to fetch bytes from an endpoint the
  // deploy never serves as `?dl=`, so it is a malformed record, not a base to
  // follow.
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
    // A DOT SEGMENT is rejected, not resolved. `new URL()` normalizes `..` before
    // `pathname` is read, so `/install/extra/..` and `/foo/../install/` both
    // present as `/install/` while the RAW string still carries the traversal -
    // and it is the raw string a consumer would build a URL from. Rejecting is
    // also what this field already does with a query and a fragment: suspicious
    // input is refused rather than silently mangled, because the installer never
    // writes any of these and a record that has one was edited by hand or by
    // something hostile.
    // Read the path off the RAW string, because `url.pathname` has already had its
    // dot segments resolved away.
    const afterScheme = raw.slice(raw.indexOf("://") + 3);
    const firstSlash = afterScheme.indexOf("/");
    const rawPath = firstSlash === -1 ? "" : afterScheme.slice(firstSlash);
    if (rawPath.split("/").some((seg) => seg === "." || seg === "..")) {
      ctx.addIssue({
        code: "custom",
        message: "installUrl must carry no `.` or `..` path segment",
      });
    }
    // Credentials likewise: `url.origin` drops them, so canonicalizing would strip
    // a userinfo pair silently. Refuse instead.
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
    // `/install/` is ACCEPTED and canonicalized by the transform below, not
    // rejected. It names the same endpoint, so refusing it would brick `update`
    // and the notice on a record a person could have hand-written or a host could
    // have redirected - a refusal that teaches the user nothing, since the two
    // spellings are indistinguishable to them. Rung 3's "refuse rather than
    // guess" is about an ABSENT ring, not about a slash: canonicalizing a URL is
    // not guessing which channel to follow.
  }),
});

/** The validated record with `installUrl` canonicalized: exactly one spelling of
 *  the endpoint reaches any consumer, so `?dl=` is always appended to `/install`.
 *  Declared after the raw schema because it wraps it.
 *
 *  Rebuilt from the PARSED URL (`origin` + the fixed path), never by editing the raw
 *  string. The refinement above reads `url.pathname`, which `new URL()` has already
 *  normalized; a transform that stripped the raw text instead was reading a
 *  different value from the one that was validated, and a `..` segment slipped
 *  through the gap. One view of the value, so they cannot disagree. */
const CanonicalInstallRecordSchema = InstallRecordSchema.transform((r) => ({
  ...r,
  installUrl: `${new URL(r.installUrl).origin}/install`,
}));

export type InstallRecord = z.infer<typeof CanonicalInstallRecordSchema>;

/**
 * The record an `install.json` body describes, or `null` when it is absent, not
 * JSON, or malformed in either field. One `null` for every unusable state,
 * because the caller treats them identically: refuse.
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

/** A followed ring: the pointer name plus the endpoint that serves it. */
export interface RingSource {
  ring: string;
  /** The recorded install endpoint, trailing slashes stripped. */
  base: string;
}

export type RingDecision =
  | ({ ok: true } & RingSource)
  | { ok: false; message: string };

/**
 * Follow the recorded ring, or refuse. The refusal names the record's path (so a
 * user can see what is missing) and the reinstall line that writes it — the only
 * way to obtain a record, by design: nothing here may invent one.
 *
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

/** Drop any trailing `/` without a regex – the parsed record is already the
 *  canonical `/install` endpoint, so this only guards a hand-built record and
 *  avoids a needless super-linear-backtracking construct on a URL string.
 *
 *  Exported because `version-notice.ts` normalizes the recorded `installUrl` too,
 *  and a second copy of the loop is a second place for the regex to come back –
 *  SonarQube flags `/\/+$/` as `typescript:S5852` every time. `skillBaseForRing`
 *  below normalizes the baked store origin through it for the same reason. Neither
 *  is a channel base: nothing bakes a ring any more.
 *  `apps/api`'s `installRoute` keeps its own copy on purpose: the two apps share
 *  no code. */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

/**
 * Where the agent SKILL body of a followed ring is fetched from: the
 * build-pinned store `origin` plus the ring RECORDED on this machine.
 *
 * The two halves are split along the line that decides where each belongs:
 *
 *  - **origin is a trust anchor.** A wrong origin serves the body AND the
 *    `SHA256SUMS` beside it, so `skill-remote.ts`'s fail-closed verify agrees with
 *    itself and cannot detect it. It must not be influenceable at run time, so it
 *    is baked and pinned to the store's host family (`release-config.ts`).
 *  - **ring is policy.** A promote moves a pointer over the SAME bytes — `cli/next`
 *    and `cli/stable` are byte-identical by construction — so one binary is both
 *    rings' binary and a channel compiled into it is wrong on one side of every
 *    promote. It has to be a fact on the machine.
 *
 * Baking the whole URL made one value answer both, and it could only satisfy the
 * first: the channel segment froze at build time while the ring moved underneath
 * it. That is issue #1751 — a `stable` install fetching the retired `skill/latest`
 * because the release baked a pre-rename Environment variable.
 *
 * `undefined` when either half is missing (an unbaked build, or no install record)
 * or the ring is not a well-formed pointer name — the caller then uses the embedded
 * copy, which is the degradation that predates the channel. Never a guessed
 * default: quietly picking a channel is the drift this removes.
 *
 * Any well-formed ring composes, including one this binary has never heard of. A
 * ring nothing is published on 404s and falls back to embedded, which is why
 * `edge` needs no channel of its own: an edge build embeds its own commit's
 * `SKILL.md` and is in sync with itself by construction. An allowlist here would
 * save one round trip and cost the property `RING_NAME` exists to protect.
 */
export function skillBaseForRing(
  origin: string | undefined,
  ring: string | undefined,
): string | undefined {
  if (!origin || !ring || !RING_NAME.test(ring)) return undefined;
  // `stripTrailingSlashes`, not `/\/+$/` — see that helper for why the regex is
  // deliberately absent from this module.
  return `${stripTrailingSlashes(origin)}/skill/${ring}`;
}

/**
 * Where one asset of a followed ring is fetched from: the recorded install
 * endpoint's own `?dl=` branch (`apps/api` `installRoute`). A ring is followed
 * through the same single first-party host the installer downloaded from, so the
 * release store's hostname stays server-side for self-update too.
 *
 * The recorded ring travels as `&ring=`, and it is REQUIRED (foundations#74 rung
 * 4). A bare `?dl=` resolves against whatever channel the DEPLOY was configured
 * with, so an install that came from a named ring would fetch a different
 * pointer's bytes on its next update — and since self-update decides on a
 * checksum difference alone, that swap is clean and undetectable: a `next` or
 * `edge` install would silently fall back to the deploy's own channel. Sending
 * the ring is what makes the pointer an install recorded the pointer it is
 * served from, which is the whole premise of rung 3's record.
 *
 * Required rather than optional so the compiler, not a reviewer, is what keeps a
 * new call site from omitting it. A ring the deploy publishes nothing on resolves
 * to a prefix with no objects, so the fetch 404s and `update` refuses — it can
 * never serve a different ring's bytes.
 */
export function ringAssetUrl(
  base: string,
  asset: string,
  ring: string,
): string {
  return `${base}?dl=${encodeURIComponent(asset)}&ring=${encodeURIComponent(ring)}`;
}

/**
 * Where a ring's SIGNED BUILD RECORD is fetched from (foundations#74 rung 9).
 *
 * The same `?dl=` convention as `ringAssetUrl`, plus `&sig=1`, which is what makes
 * the deploy resolve the name against the record prefix (`cli-sig/<ring>`) instead
 * of the download prefix (`cli/<ring>`). The two prefixes are deliberately
 * separate: a record stored beside the manifest it signs falls to the same store
 * write it exists to detect, so it would prove nothing.
 *
 * Additive to this module rather than a second URL builder elsewhere, because it is
 * the same single-host rule — the release store's hostname stays server-side for
 * the record exactly as it does for the binary.
 */
export function ringRecordUrl(
  base: string,
  asset: string,
  ring: string,
): string {
  return `${ringAssetUrl(base, asset, ring)}&sig=1`;
}
