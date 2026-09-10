#!/usr/bin/env bun
/**
 * Upload the built release artifacts (apps/cli/dist/*) to a **public** Vercel
 * Blob store, so the `GET /install` endpoint's `curl … | bash` script can pull
 * the binaries with no auth. Run by the release workflow after the binaries are
 * built; run it locally with a token to seed the store by hand.
 *
 *   BLOB_READ_WRITE_TOKEN=… bun run scripts/upload-release-blob.ts cli-v0.1.0
 *
 * Three moving pointers = the three RINGS (foundations#74 rung 4/7):
 * **cli/edge** (unreleased main, dogfood), **cli/next** (the candidate real people
 * run) and **cli/stable** (what everyone receives). `next` and `stable` serve the
 * SAME byte-identical `X.Y.Z` build — promotion is a POINTER MOVE, never a rebuild
 * — so a fresh publish can only ever reach `next`, and `stable` is reached only by
 * promoting a `next` build. The routing rule lives in `ring-rules.ts`, shared with
 * the release workflow's gates and with `GET /install?ring=`.
 *
 * Modes:
 *   <tag>                    build+publish: put dist/* → cli/<tag>/*, then advance
 *                            cli/next. No flags.
 *   --freeze <tag>           immutable-only: put dist/* → cli/<tag>/* and advance
 *                            NO pointer. The release workflow uses this so a pointer
 *                            is advanced by a SEPARATE --promote AFTER the frozen
 *                            artifact is smoke-verified. Requires an explicit tag.
 *   --promote <tag> [--to next|stable] [--require-serving <ring>]
 *                            promote-only: server-side copy an already-published
 *                            cli/<tag>/* → cli/<ring>/* with NO local dist/
 *                            (advance a ring to a verified/prior build; rollback).
 *                            --to defaults to next. Both rings serve plain X.Y.Z
 *                            only; a prerelease is refused. Explicit tag required.
 *                            --require-serving <ring> refuses unless <ring> already
 *                            serves this tag, read from the SAME store this write
 *                            targets — the promote gate. Omit it to roll back.
 *
 * --freeze/--promote take the tag ONLY from argv (no RELEASE_TAG fallback), so a
 * stray exported RELEASE_TAG can't silently promote the wrong version.
 *
 * Env knobs:
 *   BLOB_READ_WRITE_TOKEN  required to actually publish (see REQUIRE_PUBLISH).
 *   REQUIRE_PUBLISH=true   fail (exit 1) instead of the graceful skip when the
 *                          token is unset — set by the release workflow for a
 *                          deliberate stable release so a "green" run can't
 *                          silently publish nothing once Blob is provisioned.
 *   GITHUB_OUTPUT          when set, `store_origin=<origin>` is appended so the
 *                          workflow can read it as a step output (smoke tests).
 *
 * Each file is written to `cli/<tag>/<name>` (immutable, versioned, cached hard).
 * The tag then advances `cli/next/<name>` by **server-side copying** each frozen
 * `cli/<tag>` blob (short cache), so a ring is always byte-identical to the version
 * published to it, even on a resumed re-run. `cli/stable` is advanced by a separate
 * `--promote <tag> --to stable` once a human decides the candidate is good: the same
 * server-side copy of the same frozen bytes, which is why `next` and `stable` serve
 * byte-identical checksums. Stable pathname (no random suffix) so the URL is
 * predictable:
 *
 *   https://<store-id>.public.blob.vercel-storage.com/cli/stable/<name>
 *
 * Skips gracefully (exit 0) when `BLOB_READ_WRITE_TOKEN` is unset, so the release
 * workflow still succeeds before the Blob store is provisioned — the endpoint
 * just stays dormant until the base URL is configured.
 */
import { appendFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { copy, list, put } from "@vercel/blob";
import { FULCIO_ROOTS_PEM, verifySignedManifest } from "../src/release-signing";
import {
  type ConsistencyDeps,
  parseSums,
  waitChannelConsistent,
} from "./blob-consistency";
import { putImmutableAssets, resolveStoreOrigin } from "./blob-publish";
import {
  commitSidecarPath,
  identitiesForRing,
  manifestCoversAll,
  SIGNATURE_ASSET,
  SIGNING_OIDC_ISSUER,
  signedRecordRefusal,
  sigPrefixForRing,
  sigPrefixForTag,
} from "./release-signing";
import {
  isRing,
  RELEASE_ASSET_BASENAME,
  type Ring,
  ringAcceptsVersion,
} from "./ring-rules";
import { releaseTagError } from "./validate-release-tag";

// The verification manifest every consumer cross-checks binaries against. It is
// the channel-advance COMMIT POINT: copied LAST (after the binaries) and then
// waited on, so a channel is never observably "manifest ahead of the bytes it
// vouches for" — the read-after-write race that fail-closes `wego update` /
// `/install` / the release self-update smoke.
const MANIFEST = "SHA256SUMS.txt";

// The channel's advertised version — read by the INSTALLED binary's new-version
// notice, which never reads the manifest. It is an advertisement, not a
// deliverable, so it is copied strictly AFTER the commit point and after the
// deliverable channel is certified consistent (see the advance block below).
const VERSION_OBJECT = "VERSION";

// Modes (see the file header). --freeze/--promote require an EXPLICIT argv tag;
// only the bare-positional publish falls back to RELEASE_TAG.
type Mode = "publish" | "freeze" | "promote";
function parseMode(flag: string | undefined): Mode {
  if (flag === "--promote") return "promote";
  if (flag === "--freeze") return "freeze";
  return "publish";
}
const argv = process.argv.slice(2);
// Reject an unknown --flag up front with a clear message. (A bad *tag* is still
// caught by the cli-vX.Y.Z shape guard below, before any Blob access — but an
// unrecognized flag would otherwise be silently treated as a publish tag.)
if (
  argv[0]?.startsWith("--") &&
  argv[0] !== "--freeze" &&
  argv[0] !== "--promote"
) {
  console.error(
    `Unknown flag "${argv[0]}" - use --freeze or --promote, or a bare tag.`,
  );
  process.exit(1);
}
const mode = parseMode(argv[0]);
// A stray flag in the tag position (e.g. `--freeze --typo`) — clearer than
// letting it fall through to the tag-shape error below.
if (mode !== "publish" && argv[1]?.startsWith("--")) {
  console.error(`Unknown flag "${argv[1]}" after ${argv[0]} - expected a tag.`);
  process.exit(1);
}
// Strict argv shape per mode — a misplaced `--to` or a stray positional must
// ERROR, never be silently ignored. Without this, `<tag> --to stable` (publish)
// would advance cli/next despite asking for stable, and `--promote <tag> stable`
// (missing `--to`) would advance cli/next instead of the whole install base.
// `--to` is promote-only.
if (mode === "promote") {
  // ["--promote", tag] plus any of the two optional flag PAIRS, in either order.
  const flags = argv.slice(2);
  const okShape =
    flags.length % 2 === 0 &&
    flags
      .filter((_, i) => i % 2 === 0)
      .every((f) => f === "--to" || f === "--require-serving");
  if (argv.length < 2 || !okShape) {
    console.error(
      "usage: upload-release-blob.ts --promote <tag> [--to next|stable] [--require-serving <ring>]",
    );
    process.exit(1);
  }
} else {
  if (argv.includes("--to")) {
    console.error("--to is only valid with --promote.");
    process.exit(1);
  }
  if (argv.includes("--require-serving")) {
    console.error("--require-serving is only valid with --promote.");
    process.exit(1);
  }
  const positionals = mode === "freeze" ? argv.length - 1 : argv.length;
  if (positionals > 1) {
    console.error("Too many arguments - expected a single <tag>.");
    process.exit(1);
  }
}
const tag = mode === "publish" ? (argv[0] ?? process.env.RELEASE_TAG) : argv[1];
if (!tag) {
  console.error(
    "usage: upload-release-blob.ts <tag>            # build + publish (+ advance cli/next)\n" +
      "       upload-release-blob.ts --freeze <tag>   # publish cli/<tag> only (never move a ring)\n" +
      "       upload-release-blob.ts --promote <tag> [--to next|stable]  # copy cli/<tag> → a ring\n" +
      (mode !== "publish"
        ? `\n${mode} requires an explicit <tag> argument (no RELEASE_TAG fallback).`
        : ""),
  );
  process.exit(1);
}

// Guard the tag through the SAME validator the release workflow and the builder
// use. The `cli-v*` push glob could otherwise pass a dashless junk tag like
// `cli-vlatest`, which would read as a plain version and move cli/next — or a
// semver-invalid one like `cli-v0.4.3-rc.01`, which the installed binary's
// comparator rejects, permanently silencing its new-version notice. One authority,
// so no entry point can be the hole in it.
const tagError = releaseTagError(tag);
if (tagError) {
  console.error(`Refusing to publish: ${tagError}`);
  process.exit(1);
}

// Resolved BEFORE the token check, beside the tag gate above and for the same
// reason: a mistyped ring is a caller mistake, and the graceful no-token skip
// below exits 0, so validating after it would swallow the typo entirely on a
// local run.
const requireServing = mode === "promote" ? parseRequireServing() : null;

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  const msg =
    "BLOB_READ_WRITE_TOKEN unset - no Blob store to publish to. " +
    "Provision a Vercel Blob store + set the secret to publish binaries.";
  // REQUIRE_PUBLISH: a deliberate release (workflow sets it for a stable tag)
  // must FAIL rather than exit 0 with nothing published — a silent no-op once
  // Blob is live would ship a "successful" release that changed nothing.
  if (process.env.REQUIRE_PUBLISH === "true") {
    console.error(`${msg} REQUIRE_PUBLISH is set — failing the release.`);
    process.exit(1);
  }
  console.warn(`${msg} Until then GET /install stays dormant.`);
  process.exit(0);
}

// The rings `next` and `stable` are the SAME stable line at two distances from the
// install base - `ring-rules.ts` owns the rule, so the workflow's gates and this
// script's guard below can never disagree:
//   cli/next   - the candidate real people run. A fresh publish lands here.
//   cli/stable - what everyone receives. Reached ONLY by promoting a next build.
//
// Which moving pointer(s) this run advances, if any. --freeze advances nothing;
// --promote advances its `--to` target (default next); a bare publish advances
// cli/next, so a local one-shot reproduces the release job's routing instead of
// putting a fresh build in front of the whole install base.
function parsePromoteTarget(): Ring {
  const i = argv.indexOf("--to");
  if (i < 0) return "next";
  const v = argv[i + 1];
  // Every ring is a nameable target, `edge` included. It was refused here while
  // this lived in wego-ai, on the reasoning that the edge lane publishes its own
  // `X.Y.Z-edge.<sha>` builds (publish-edge-blob.ts) and a plain release version
  // must never land on `edge`. That is still true as a DEFAULT - the default is
  // `next`, and nothing routes a release to `edge` on its own - but a parser that
  // cannot even name a ring the promote lane operates on is the wrong place to
  // enforce it: an operator promoting deliberately gets a usage error instead of
  // the promote, and the real guards (the tag gate, `--require-serving`, and the
  // byte-identity check against `cli/<tag>/`) are the ones that decide whether a
  // given ring may be advanced.
  if (v && isRing(v)) return v;
  console.error(
    `--to must name a ring: edge, next or stable (got "${v ?? ""}").`,
  );
  process.exit(1);
}
/**
 * `--require-serving <ring>`: the ring that must already serve this tag before the
 * promote may proceed, or `null` when the flag is absent. Resolved HERE, at argv
 * time and beside the tag gate, so a typo costs one cheap step rather than a Blob
 * round trip - the same reason `releaseTagError` runs before any store access.
 */
function parseRequireServing(): Ring | null {
  const i = argv.indexOf("--require-serving");
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v && isRing(v)) return v;
  console.error(
    `--require-serving must name a ring: edge, next or stable (got "${v ?? ""}").`,
  );
  process.exit(1);
}
function computeAdvanceTargets(): Ring[] {
  if (mode === "promote") return [parsePromoteTarget()];
  if (mode === "freeze") return [];
  return ["next"];
}
const advanceTargets = computeAdvanceTargets();

// Refused because `update` replaces the running binary on a CHECKSUM difference,
// never a version comparison, so whatever a ring serves is what its install base
// receives on the next `update`. A prerelease on `next` or `stable` ships a build
// neither line opted into.
for (const target of advanceTargets) {
  const crossing = ringAcceptsVersion(target, tag);
  if (crossing) {
    console.error(crossing);
    process.exit(1);
  }
}

let storeOrigin = "";
let names: string[];

if (mode === "promote") {
  // Promote-only: no local build. The artifact set is whatever cli/<tag>/ already
  // holds (a prior, already-tested release); phase 2 below re-points the target
  // channel at it. Fail loudly if the tag was never published.
  const existing = await list({ prefix: `cli/${tag}/`, token });
  if (existing.blobs.length === 0) {
    console.error(
      `Nothing published at cli/${tag}/ - cannot promote a tag that was never released.`,
    );
    process.exit(1);
  }
  storeOrigin = new URL(existing.blobs[0].url).origin;
  names = existing.blobs.map((b) => b.pathname.slice(`cli/${tag}/`.length));

  // --require-serving <ring>: refuse unless <ring> currently serves this tag.
  //
  // The promote decision is about a build people have been RUNNING, so promoting a
  // tag the candidate ring does not serve is a mistake - and an unrecallable one,
  // since nothing reaches a machine that already installed.
  //
  // The check lives HERE, not in the workflow, because of which STORE it has to
  // ask. A workflow-side `GET /install?dl=VERSION&ring=next` resolves against that
  // deploy's own `CLI_DOWNLOAD_BASE_URL`, while this script writes to the origin it
  // just discovered from `cli/<tag>/`. Nothing enforces that those are the same
  // store, so the gate could read one store's `next` and then promote in another -
  // passing or refusing on a fact about the wrong place. Reading it from
  // `storeOrigin` makes the gate and the write the same store by construction.
  if (requireServing) {
    const ring = requireServing;
    const versionUrl = `${storeOrigin}/cli/${ring}/${VERSION_OBJECT}`;
    const res = await fetch(versionUrl, { cache: "no-store" });
    if (!res.ok) {
      console.error(
        `Cannot read ${versionUrl} (HTTP ${res.status}) - refusing to promote without confirming what cli/${ring} serves.`,
      );
      process.exit(1);
    }
    const served = (await res.text()).trim();
    const want = tag.replace(/^cli-v/, "");
    if (served !== want) {
      console.error(
        `cli/${ring} serves ${served}, not ${want}. Promote the build that ring has been running, ` +
          "or drop --require-serving when you are deliberately rolling back to an older build.",
      );
      process.exit(1);
    }
    console.log(`ok: cli/${ring} serves ${want} (${versionUrl}).`);
  }

  console.log(
    `Promoting cli/${tag}/ (${names.length} files) → ${advanceTargets
      .map((t) => `cli/${t}`)
      .join(" + ")}.`,
  );
} else {
  const distDir = "dist";
  names = await readdir(distDir);
  if (names.length === 0) {
    console.error(
      `No artifacts in ${distDir}/ - run \`bun run build:binaries\` first.`,
    );
    process.exit(1);
  }

  // Complete-artifact-set guard. One filename on every ring: the flavor split that
  // baked the backend into the asset name is gone (rung 7), so a release set is the
  // single `wego-*` family and the TARGET is chosen at run time. What still has to
  // hold is that the set is not empty of deliverables - a dist/ carrying only
  // SHA256SUMS.txt, or stray pre-cutover second-flavor bytes lying around, would
  // publish an artifact `/install` cannot download.
  const stale = names.filter((n) =>
    n.startsWith(`${RELEASE_ASSET_BASENAME}staging-`),
  );
  if (stale.length > 0) {
    console.error(
      `dist/ carries pre-cutover ${RELEASE_ASSET_BASENAME}staging-* binaries (${stale.join(", ")}). ` +
        "The flavor axis is gone - every ring serves the one `wego-*` asset and the backend is " +
        "chosen at run time with --target. Wipe dist/ and rebuild with `bun run build:binaries`.",
    );
    process.exit(1);
  }
  const binaries = names.filter((n) =>
    n.startsWith(`${RELEASE_ASSET_BASENAME}-`),
  );
  if (binaries.length === 0) {
    console.error(
      `dist/ carries no ${RELEASE_ASSET_BASENAME}-* binaries - publish/freeze would ship a set ` +
        "`/install` cannot download. Run `bun run build:binaries` first.",
    );
    process.exit(1);
  }

  // COVERAGE, CHECKED HERE RATHER THAN AT THE POINTER MOVE. The same rule
  // `manifestCoversAll` enforces before advancing a ring, run against dist/ before
  // anything is uploaded. `cli-v0.7.1` published 13 objects and verified all of
  // them, then refused its own pointer move nine steps later because one was not in
  // the signed manifest (run 33036257401). The information was available the moment
  // dist/ was signed; only the check was in the wrong place. Failing here costs a
  // build, not a burned version number - the tag's COMMIT sidecar makes a
  // re-publish from a different commit impossible, so a late refusal is expensive in
  // a way an early one is not.
  const distManifest = names.includes(MANIFEST)
    ? await readFile(`${distDir}/${MANIFEST}`, "utf8")
    : "";
  const distCoverage = manifestCoversAll(distManifest, names);
  if (distCoverage) {
    console.error(
      `${distCoverage}\nChecked against dist/ before publishing: every object under ` +
        "cli/<tag>/ must be listed in the manifest that was signed. Add the file to " +
        "dist/ before the checksums step, or keep it off the download prefix " +
        "entirely (see commitSidecarPath).",
    );
    process.exit(1);
  }

  // Phase 1 — immutable versioned copies (cached hard). Idempotent so a re-run
  // after a partial upload resumes: skip anything the pre-list already shows, and
  // treat an "already exists" put error as success too — Vercel Blob is
  // read-after-write eventually-consistent, so a fast retry's list() may not yet
  // show a just-written blob. (Single-page list is fine: ~21 artifacts per tag.)
  const existing = await list({ prefix: `cli/${tag}/`, token });
  const present = new Set(existing.blobs.map((b) => b.pathname));
  if (existing.blobs[0]) storeOrigin = new URL(existing.blobs[0].url).origin;

  // Bind a resume to the commit that first published this tag. `bun build
  // --compile` is non-reproducible, so re-running a partially-published tag after
  // the branch has moved would mix bytes from two builds (SMOKE-2's verify-all
  // catches that), and a fully-published-then-resumed tag could get a git tag
  // pointing at a different commit than its binaries. If a prior COMMIT sidecar
  // disagrees with this run's commit, refuse — bump the version instead.
  const releaseCommit = process.env.RELEASE_COMMIT?.trim();
  if (releaseCommit) {
    const commitPath = commitSidecarPath(tag);
    // An unreadable, empty, or mismatched sidecar is a HARD refusal — never
    // fail-open on the "don't bind a tag to a different commit" invariant.
    const assertCommit = async (url: string): Promise<void> => {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(
          `Cannot read ${commitPath} (HTTP ${res.status}) - refusing to resume without confirming the build commit.`,
        );
        process.exit(1);
      }
      const published = (await res.text()).trim();
      if (!published) {
        console.error(
          `Empty ${commitPath} - refusing to resume without confirming the build commit.`,
        );
        process.exit(1);
      }
      if (published !== releaseCommit) {
        console.error(
          `cli/${tag}/ was first published from commit ${published}, but this run is ${releaseCommit}. ` +
            "Re-running against a moved branch would mix builds - bump the version instead of re-releasing this tag.",
        );
        process.exit(1);
      }
    };
    // Listed directly: the sidecar lives on the RECORD prefix now, so the
    // `cli/<tag>/` listing above cannot see it.
    const priorList = await list({ prefix: commitPath, token });
    const prior = priorList.blobs.find((b) => b.pathname === commitPath);
    if (prior) {
      await assertCommit(prior.url);
    } else {
      try {
        await put(commitPath, releaseCommit, {
          access: "public",
          addRandomSuffix: false,
          allowOverwrite: false, // immutable: first writer wins, resumes re-read
          token,
        });
        console.log(`↑ ${commitPath} (${releaseCommit})`);
      } catch (err) {
        // Same idempotent-resume path as the binary loop below: an "already
        // exists" (incl. precondition/ETag) means a prior run wrote it though
        // list() hasn't surfaced it yet (read-after-write lag). Re-list to get
        // its URL and verify it matches — never crash a legitimate resume.
        if (
          !(
            err instanceof Error &&
            /already exists|precondition|etag/i.test(err.message)
          )
        )
          throw err;
        const after = await list({ prefix: commitPath, token });
        const found = after.blobs.find((b) => b.pathname === commitPath);
        if (!found) {
          console.error(
            `${commitPath} reported as already-existing but is not listable — aborting.`,
          );
          process.exit(1);
        }
        await assertCommit(found.url);
      }
    }
  }

  // The signed build record is published to the RECORD prefix, never alongside the
  // downloads (foundations#74 rung 9): a record the same store write can replace
  // proves nothing the manifest did not already prove. So it is split out of the
  // download set here rather than filtered later — the one place `dist/` is turned
  // into an upload list.
  const recordNames = names.filter((name) => name === SIGNATURE_ASSET);
  names = names.filter((name) => name !== SIGNATURE_ASSET);

  // The immutable phase is identical to the edge lane's, so it lives in
  // `blob-publish.ts` — including the already-published resume rule.
  storeOrigin = await putImmutableAssets({
    names,
    distDir,
    prefix: `cli/${tag}`,
    present,
    token,
    storeOrigin,
  });
  if (recordNames.length) {
    storeOrigin = await putImmutableAssets({
      names: recordNames,
      distDir,
      prefix: sigPrefixForTag(tag),
      present,
      token,
      storeOrigin,
    });
  } else {
    // Not fatal here: `--freeze` publishes, and the gate that matters refuses to
    // advance a POINTER without a record (phase 2). Saying so loudly beats failing
    // a publish whose only defect is that nothing will be promotable from it.
    console.warn(
      `warning: dist/ carries no ${SIGNATURE_ASSET} — cli/${tag} will not be promotable until one is published.`,
    );
  }
  // A fully-resumed run uploads nothing, so the origin can still be unknown here
  // (see `resolveStoreOrigin`). Recover it before it reaches the manifest URL.
  storeOrigin = await resolveStoreOrigin({
    storeOrigin,
    prefix: `cli/${tag}`,
    token,
  });
  if (!storeOrigin) {
    console.error(
      `Cannot determine the Blob store origin for cli/${tag}/ — nothing was uploaded and the prefix lists no blobs, so there is no channel to certify.`,
    );
    process.exit(1);
  }
}

// Phase 2 — advance the moving pointer(s) in `advanceTargets` (cli/next and/or
// cli/stable), but ONLY after every immutable copy above exists. Each file is
// **server-side copied from its frozen cli/<tag> blob** (not re-uploaded from the
// local dist/): a resumed re-run rebuilds dist/, and `bun build --compile` isn't
// byte-reproducible, so copying guarantees the pointer is byte-identical to the
// published version rather than a drifted rebuild. Short cache so a release
// propagates in ~a minute.
//
// The ring is advanced as a NON-ATOMIC multi-object copy over a CDN, and a
// verifying consumer reads TWO coupled objects (SHA256SUMS.txt + a binary) and
// cross-checks them. So the ORDER matters (was the root of a fail-closed smoke
// failure when the manifest was copied first, fronting a still-old binary):
//   1. copy every binary (+ COMMIT) first,
//   2. copy SHA256SUMS.txt — the commit point for every VERIFYING consumer,
//   3. wait until the ring's OWN served URLs are self-consistent to a plain
//      reader (`waitChannelConsistent`),
//   4. copy VERSION LAST, then wait again — it is the ADVERTISEMENT the installed
//      binary's notice reads without ever reading the manifest, so it must never
//      name a release the channel cannot already deliver.
// So a channel is never *reported* advanced while a reader could still observe a
// new manifest next to a stale binary. --freeze advances nothing (the workflow
// promotes separately after verifying); --promote advances its --to target; a
// bare publish advances the one channel the tag belongs on. (No manifest/pointer
// indirection — see PR #1054; this closes the same-race window without it.)
if (advanceTargets.length) {
  if (!names.includes(MANIFEST)) {
    console.error(
      `cli/${tag}/ has no ${MANIFEST} — refusing to advance a channel that can't be consistency-verified.`,
    );
    process.exit(1);
  }

  // The tag's manifest is the source of truth for what a consistent channel must
  // serve (immutable, already fully verified by the workflow's SMOKE-2). Read it
  // once to drive the post-copy barrier for every target. It was just written in
  // phase 1 (or exists from a prior release, for --promote), so a transient miss
  // is read-after-write lag, not a real absence: retry a bounded few times before
  // failing — matching this file's COMMIT-sidecar read-after-write handling
  // rather than aborting the whole promote on the first hiccup.
  const tagSumsUrl = `${storeOrigin}/cli/${tag}/${MANIFEST}`;
  const readTagSums = async (attempts = 5): Promise<string> => {
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(tagSumsUrl, {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return await res.text();
        console.warn(
          `cli/${tag}/${MANIFEST} → HTTP ${res.status} (attempt ${i}/${attempts}; read-after-write lag?)`,
        );
      } catch (err) {
        console.warn(
          `cli/${tag}/${MANIFEST} fetch failed (attempt ${i}/${attempts}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (i < attempts) await Bun.sleep(2_000);
    }
    return "";
  };
  const tagSumsText = await readTagSums();
  if (!tagSumsText) {
    console.error(
      `Cannot read cli/${tag}/${MANIFEST} after retries — needed to certify channel consistency.`,
    );
    process.exit(1);
  }
  const expectedSums = parseSums(tagSumsText);
  if (expectedSums.size === 0) {
    console.error(
      `cli/${tag}/${MANIFEST} lists no assets — refusing to advance an unverifiable channel.`,
    );
    process.exit(1);
  }

  // ── A pointer can never name an unsigned file (foundations#74 rung 9) ────────
  //
  // The consistency barriers below prove the channel serves the same BYTES the tag
  // does. They cannot prove those bytes came from us: a store writer who replaced
  // the binary and the manifest together would satisfy every one of them. So before
  // any pointer moves, require a signed build record for this tag, and require it to
  // cover every object about to be served.
  //
  // Refused rather than warned, and refused on ABSENCE as well as on a bad record:
  // "no record yet, advance anyway" is the state an attacker would arrange, and it is
  // also the state a half-finished release workflow produces. Neither should reach a
  // ring that real installs follow.
  const recordUrl = `${storeOrigin}/${sigPrefixForTag(tag)}/${SIGNATURE_ASSET}`;
  const recordRes = await fetch(recordUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  }).catch((err: unknown) => {
    console.error(
      `Cannot read ${recordUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });
  if (!recordRes?.ok) {
    console.error(
      `No signed build record at ${recordUrl}` +
        (recordRes ? ` (HTTP ${recordRes.status})` : "") +
        ` — refusing to advance a pointer onto an unsigned release.`,
    );
    process.exit(1);
  }
  let record: unknown;
  try {
    record = JSON.parse(await recordRes.text());
  } catch {
    console.error(
      `The signed build record at ${recordUrl} is not JSON — refusing to advance.`,
    );
    process.exit(1);
  }
  // Every ring this run would advance must accept the identity that signed the
  // record: the edge lane's records are not release records, and vice versa.
  for (const ring of advanceTargets) {
    const verdict = await verifySignedManifest({
      bundle: record,
      payload: new TextEncoder().encode(tagSumsText),
      identity: identitiesForRing(ring),
      issuer: SIGNING_OIDC_ISSUER,
      rootsPem: FULCIO_ROOTS_PEM,
    });
    if (!verdict.ok) {
      console.error(
        signedRecordRefusal(`cli/${tag}/${MANIFEST}`, ring, verdict.reason),
      );
      process.exit(1);
    }
  }
  // …and the record only vouches for what the manifest LISTS, so an object the
  // manifest omits is an object nothing signed.
  const coverage = manifestCoversAll(tagSumsText, names);
  if (coverage) {
    console.error(coverage);
    process.exit(1);
  }
  console.log(
    `Signed build record verified for cli/${tag} (${advanceTargets.join(", ")}).`,
  );

  const consistencyDeps: ConsistencyDeps = {
    fetch,
    hash: async (body) => {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(body);
      return hasher.digest("hex");
    },
    sleep: (ms) => Bun.sleep(ms),
    log: (message) => console.log(message),
  };

  // The first barrier certifies the DELIVERABLE channel, before `VERSION` is
  // copied. It still compares against the FULL manifest — the served
  // `SHA256SUMS.txt` lists `VERSION` too, so a trimmed map would be a size
  // mismatch that never converges — and only skips reading that one body.
  const hasVersionObject = names.includes(VERSION_OBJECT);
  const deliverableDeps: ConsistencyDeps = {
    ...consistencyDeps,
    skipAssets: new Set([VERSION_OBJECT]),
  };
  // The second barrier is the mirror image: the deliverables were certified
  // moments earlier and nothing rewrites them in between, so re-hashing ~700 MB
  // of binaries would only add minutes to every promote. Re-compare the manifest
  // (cheap) and read the one body that is new.
  const versionOnlyDeps: ConsistencyDeps = {
    ...consistencyDeps,
    skipAssets: new Set(
      [...expectedSums.keys()].filter((name) => name !== VERSION_OBJECT),
    ),
  };

  for (const target of advanceTargets) {
    // 1) Binaries + COMMIT first — everything EXCEPT the manifest and VERSION.
    //    Their relative order is irrelevant to correctness (only manifest-last
    //    matters), so copy them concurrently to cut promote latency.
    await Promise.all(
      names
        .filter((name) => name !== MANIFEST && name !== VERSION_OBJECT)
        .map(async (name) => {
          const { url } = await copy(
            `cli/${tag}/${name}`,
            `cli/${target}/${name}`,
            {
              access: "public",
              allowOverwrite: true,
              cacheControlMaxAge: 60,
              token,
            },
          );
          console.log(`↝ ${url} (from cli/${tag})`);
        }),
    );
    // 2) The signed build record, immediately before the manifest it vouches for.
    //    Order matters and neither order is free: a ring briefly serving a new
    //    manifest under an old record, or the reverse, makes a client REFUSE — both
    //    fail closed, so the cost is a moment of "try again", never an unverified
    //    install. Putting the record first and the manifest last keeps that window
    //    to two adjacent writes of a few KB each, and keeps the manifest as the one
    //    commit point everything else is ordered around.
    const { url: recordUrlCopied } = await copy(
      `${sigPrefixForTag(tag)}/${SIGNATURE_ASSET}`,
      `${sigPrefixForRing(target)}/${SIGNATURE_ASSET}`,
      { access: "public", allowOverwrite: true, cacheControlMaxAge: 60, token },
    );
    console.log(`↝ ${recordUrlCopied} (from ${sigPrefixForTag(tag)}) [record]`);
    // 3) Manifest LAST — the commit point.
    const { url: manifestUrl } = await copy(
      `cli/${tag}/${MANIFEST}`,
      `cli/${target}/${MANIFEST}`,
      { access: "public", allowOverwrite: true, cacheControlMaxAge: 60, token },
    );
    console.log(`↝ ${manifestUrl} (from cli/${tag}) [manifest — commit point]`);
    // 4) Certify the channel is self-consistent to a plain reader before we
    //    report it advanced (and before the workflow's self-update smoke reads it).
    await waitChannelConsistent(
      `${storeOrigin}/cli/${target}`,
      expectedSums,
      hasVersionObject ? deliverableDeps : consistencyDeps,
    );
    // 5) VERSION strictly last — AFTER the channel can actually serve what it
    //    advertises. The installed binary's new-version notice reads VERSION and
    //    never the manifest, so copying it in phase 1 announces a release the
    //    channel cannot yet deliver: the user is told to update, `wego update`
    //    still reads the old manifest and reports itself current, and the notice
    //    PERSISTS its answer — so one propagation window turns into a whole
    //    throttle window of contradiction (24h on prod). Advertise late instead:
    //    a briefly stale VERSION only delays a notice, which costs nothing.
    if (hasVersionObject) {
      const { url: versionUrl } = await copy(
        `cli/${tag}/${VERSION_OBJECT}`,
        `cli/${target}/${VERSION_OBJECT}`,
        {
          access: "public",
          allowOverwrite: true,
          cacheControlMaxAge: 60,
          token,
        },
      );
      console.log(
        `↝ ${versionUrl} (from cli/${tag}) [VERSION — advertised after the commit point]`,
      );
      // Certify again, now reading VERSION, so the promote is not reported done
      // while a reader could still see the previous advertisement.
      await waitChannelConsistent(
        `${storeOrigin}/cli/${target}`,
        expectedSums,
        versionOnlyDeps,
      );
    }
  }
}

if (advanceTargets.length) {
  const advanced = advanceTargets.map((t) => `cli/${t}`).join(" + ");
  console.log(`\nUpdated ${advanced} (copied from cli/${tag}).`);
} else {
  // The only way to advance nothing: computeAdvanceTargets returns [] for
  // --freeze alone — a bare publish now always routes to exactly one channel,
  // and --promote always carries its --to target.
  console.log(
    `\nFroze cli/${tag}/ - no pointer advanced (advance it with --promote after verifying).`,
  );
}
if (storeOrigin) {
  // Human-readable line for a local run.
  console.log(`STORE_ORIGIN=${storeOrigin}`);
  // Print the CLI_DOWNLOAD_BASE_URL hint for the ring(s) this run advanced (so a
  // `--to stable` promote doesn't print a misleading cli/next base); fall back to
  // stable when nothing advanced (e.g. --freeze, before a later promote).
  const hintRings = advanceTargets.length ? advanceTargets : ["stable"];
  console.log("Set on the matching apps/api deploy:");
  for (const ring of hintRings) {
    console.log(`  CLI_DOWNLOAD_BASE_URL=${storeOrigin}/cli/${ring}`);
  }
  // In CI, expose it as a step output (the workflow smoke-tests the artifact
  // straight from the store) — no fragile log-scraping.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `store_origin=${storeOrigin}\n`);
  }
}
