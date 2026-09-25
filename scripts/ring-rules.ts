/**
 * The three release rings and the version shape each one is allowed to carry.
 *
 *   cli/edge    unreleased main, dogfood only   → `X.Y.Z-edge.<sha>` builds
 *   cli/next    a candidate real people run     → plain `X.Y.Z`
 *   cli/stable  what everyone receives          → plain `X.Y.Z`
 *
 * `next` and `stable` serve the same byte-identical `X.Y.Z` build: promotion is a
 * pointer move, never a rebuild (`src/update.ts` compares checksums, not versions),
 * so both accept only a plain release version. `edge` is the one prerelease line,
 * pinned to `-edge.`: an `-rc.*` or plain build must never land on it, because
 * whatever a ring serves is what its install base receives on the next `update`.
 *
 * Every ring serves the one `wego-*` asset; the backend is chosen at run time by
 * `--target`, so "which ring" is the pointer, never the filename.
 *
 * Pure rules, no I/O. `upload-release-blob.ts` and `publish-edge-blob.ts` enforce
 * them at publish time; `GET /install?ring=` resolves the same three names. A shape
 * check, not a semver parse, so it states only the distinction each ring turns on.
 */

/** A moving ring pointer. `cli/<version>` (immutable) is not a ring. */
export const RINGS = ["edge", "next", "stable"] as const;
export type Ring = (typeof RINGS)[number];

/**
 * The ring `GET /install?ring=` serves when none is asked for. Defaulting anywhere
 * but `stable` would hand a first install a candidate or a dogfood build.
 */
export const DEFAULT_RING: Ring = "stable";

export const RELEASE_ASSET_BASENAME = "wego";

export function isRing(value: string): value is Ring {
  return (RINGS as readonly string[]).includes(value);
}

/**
 * The ring a `?ring=` value names: the default when absent or empty, `null` when it
 * is a name outside the closed set. `null` is a refusal, never a fallback to the
 * default: an unknown ring is a caller mistake, and guessing one would serve bytes
 * from a pointer nobody asked for.
 */
export function resolveRing(raw: string | undefined | null): Ring | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RING;
  return isRing(raw) ? raw : null;
}

function bareVersion(version: string): string {
  return version.replace(/^v/, "");
}

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

/** An edge build `X.Y.Z-edge.<id>`, where `<id>` is the built commit. */
const EDGE_VERSION = /^\d+\.\d+\.\d+-edge\.[0-9A-Za-z][0-9A-Za-z.-]*$/;

export function isPlainVersion(version: string): boolean {
  return PLAIN_VERSION.test(bareVersion(version));
}

export function isEdgeVersion(version: string): boolean {
  return EDGE_VERSION.test(bareVersion(version));
}

/**
 * The one ring a version may publish to, or `null` when its shape fits no ring (an
 * `-rc.*` or any other non-edge prerelease). A plain `X.Y.Z` routes to `next`:
 * `stable` is only reached by promoting a `next` build, never by a fresh publish.
 */
export function ringForVersion(version: string): Ring | null {
  if (isEdgeVersion(version)) return "edge";
  if (isPlainVersion(version)) return "next";
  return null;
}

/**
 * `null` when `ring` may carry `version`, else the reason as one line for stderr.
 * The crossed pair is refused in both directions: a plain build on `edge`,
 * or a prerelease (edge or rc) on `next`/`stable`, each ships the wrong shape to a
 * real install base.
 */
export function ringAcceptsVersion(ring: Ring, version: string): string | null {
  const v = bareVersion(version);
  if (ring === "edge") {
    return isEdgeVersion(v)
      ? null
      : `Refusing ${v} on ring edge - edge serves only X.Y.Z-edge.* builds.`;
  }
  // next and stable are the same stable line.
  return isPlainVersion(v)
    ? null
    : `Refusing ${v} on ring ${ring} - ${ring} serves only plain X.Y.Z releases.`;
}

export function prefixForRing(ring: Ring): string {
  return `cli/${ring}`;
}

export function assetName(platform: string): string {
  return `${RELEASE_ASSET_BASENAME}-${platform}`;
}
