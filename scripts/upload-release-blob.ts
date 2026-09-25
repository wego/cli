#!/usr/bin/env bun
/**
 * Upload the built release artifacts (dist/*) to a public Vercel Blob store, so
 * the `GET /install` endpoint's `curl … | bash` script can pull the binaries with
 * no auth. Run by the release workflow after the binaries are built; run it
 * locally with a token to seed the store by hand.
 *
 *   BLOB_READ_WRITE_TOKEN=… bun run scripts/upload-release-blob.ts v0.1.0
 *
 * The three moving pointers are the rings: cli/edge (unreleased main, dogfood),
 * cli/next (the candidate real people run) and cli/stable (what everyone
 * receives). `next` and `stable` serve the same byte-identical `X.Y.Z` build, so a
 * fresh publish only reaches `next`, and `stable` is reached only by promoting a
 * `next` build. The rules live in `ring-rules.ts`.
 *
 * Modes:
 *   <tag>                    build+publish: put dist/* → cli/<tag>/*, then advance
 *                            cli/next. No flags.
 *   --freeze <tag>           immutable-only: put dist/* → cli/<tag>/* and advance
 *                            no pointer. The release workflow uses this so a pointer
 *                            is advanced by a separate --promote after the frozen
 *                            artifact is smoke-verified. Requires an explicit tag.
 *   --promote <tag> [--to next|stable] [--require-serving <ring>]
 *                            promote-only: server-side copy an already-published
 *                            cli/<tag>/* → cli/<ring>/* with NO local dist/
 *                            (advance a ring to a verified/prior build; rollback).
 *                            --to defaults to next. Both rings serve plain X.Y.Z
 *                            only; a prerelease is refused. Explicit tag required.
 *                            --require-serving <ring> refuses unless <ring> already
 *                            serves this tag, read from the same store this write
 *                            targets (the promote gate). Omit it to roll back.
 *
 * --freeze/--promote take the tag ONLY from argv (no RELEASE_TAG fallback), so a
 * stray exported RELEASE_TAG can't silently promote the wrong version.
 *
 * Env knobs:
 *   BLOB_READ_WRITE_TOKEN  required to actually publish (see REQUIRE_PUBLISH).
 *   REQUIRE_PUBLISH=true   fail (exit 1) instead of the graceful skip when the
 *                          token is unset. The release workflow sets it so a
 *                          green run can't silently publish nothing.
 *   GITHUB_OUTPUT          when set, `store_origin=<origin>` is appended so the
 *                          workflow can read it as a step output (smoke tests).
 *
 * Each file is written to `cli/<tag>/<name>` (immutable, versioned, cached hard).
 * A ring is advanced by server-side copying each frozen `cli/<tag>` blob (short
 * cache), so it is always byte-identical to the version published to it, even on
 * a resumed re-run. `cli/stable` is advanced by a separate
 * `--promote <tag> --to stable` once a human decides the candidate is good, which
 * is why `next` and `stable` serve identical checksums. No random suffix, so the
 * URL is predictable:
 *
 *   https://<store-id>.public.blob.vercel-storage.com/cli/stable/<name>
 *
 * Skips (exit 0) when `BLOB_READ_WRITE_TOKEN` is unset, unless REQUIRE_PUBLISH is
 * set.
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
  computeAdvanceTargets,
  isArgvError,
  leadingFlagError,
  parseMode,
  parseRequireServing,
  tagPositionError,
} from "./release-argv";
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
import { RELEASE_ASSET_BASENAME, ringAcceptsVersion } from "./ring-rules";
import { releaseTagError } from "./validate-release-tag";

// The manifest every consumer cross-checks binaries against. It is the ring
// advance's commit point: copied after the binaries and then waited on, so a ring
// never serves a manifest ahead of the bytes it vouches for (which would make
// `wego update`, `/install` and the self-update smoke fail closed).
const MANIFEST = "SHA256SUMS.txt";

// The ring's advertised version, read by the installed binary's new-version
// notice, which never reads the manifest. It is copied after the commit point and
// after the deliverables are certified consistent (see the advance block below).
const VERSION_OBJECT = "VERSION";

// This module runs its whole publish at import, so the argv decisions live in
// `release-argv.ts` where they can be tested. The exiting stays here.
const argv = process.argv.slice(2);
const mode = parseMode(argv[0]);
const flagProblem = leadingFlagError(argv) ?? tagPositionError(argv, mode);
if (flagProblem) {
  console.error(flagProblem.error);
  process.exit(1);
}
// Strict argv shape per mode: a misplaced `--to` or a stray positional must
// error, never be ignored. Otherwise `<tag> --to stable` (publish) would advance
// cli/next despite asking for stable, and `--promote <tag> stable` (missing
// `--to`) would advance cli/next instead of stable.
if (mode === "promote") {
  // ["--promote", tag] plus either of the two optional flag pairs, in any order.
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

// The same validator the release workflow and the builder use. The `v*` push glob
// would otherwise pass a junk tag like `vlatest`, or a semver-invalid one like
// `v0.4.3-rc.01`, which the installed binary's comparator rejects, permanently
// silencing its new-version notice.
const tagError = releaseTagError(tag);
if (tagError) {
  console.error(`Refusing to publish: ${tagError}`);
  process.exit(1);
}

// Resolved before the token check: the no-token skip below exits 0, so validating
// after it would swallow a mistyped ring on a local run.
const requireServingResult =
  mode === "promote" ? parseRequireServing(argv) : null;
if (isArgvError(requireServingResult)) {
  console.error(requireServingResult.error);
  process.exit(1);
}
const requireServing = requireServingResult;

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  const msg =
    "BLOB_READ_WRITE_TOKEN unset - no Blob store to publish to. " +
    "Provision a Vercel Blob store + set the secret to publish binaries.";
  // A deliberate release sets REQUIRE_PUBLISH so it fails rather than reporting
  // success having published nothing.
  if (process.env.REQUIRE_PUBLISH === "true") {
    console.error(`${msg} REQUIRE_PUBLISH is set — failing the release.`);
    process.exit(1);
  }
  console.warn(`${msg} Until then GET /install stays dormant.`);
  process.exit(0);
}

const advanceResult = computeAdvanceTargets(mode, argv);
if (isArgvError(advanceResult)) {
  console.error(advanceResult.error);
  process.exit(1);
}
const advanceTargets = advanceResult;

// `update` replaces the running binary on a checksum difference, never a version
// comparison, so whatever a ring serves is what its install base receives next.
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
  // No local build: the artifact set is whatever cli/<tag>/ already holds, and
  // phase 2 below points the target ring at it.
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
  // Promotion is about a build people have been running, and a wrong promote
  // cannot be recalled from machines that already installed it.
  //
  // The check lives here, not in the workflow, because a workflow-side
  // `GET /install?dl=VERSION&ring=next` resolves against that deploy's
  // `CLI_DOWNLOAD_BASE_URL`, which need not be the store this script writes to.
  // Reading from `storeOrigin` makes the gate and the write the same store.
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
    const want = tag.replace(/^v/, "");
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

  // Complete-artifact-set guard. A release set is the single `wego-*` family. A
  // dist/ carrying only SHA256SUMS.txt, or stale `wegostaging-*` binaries from an
  // old build, would publish an artifact `/install` cannot download.
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

  // The same coverage rule `manifestCoversAll` enforces before advancing a ring,
  // run against dist/ before anything is uploaded. Failing here costs a build;
  // failing at the pointer move burns the version, because the tag's COMMIT
  // sidecar prevents a re-publish from a different commit.
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

  // Phase 1: immutable versioned copies (cached hard). Idempotent so a re-run
  // after a partial upload resumes: skip anything the pre-list already shows, and
  // treat an "already exists" put error as success too, because Vercel Blob is
  // eventually consistent and a fast retry's list() may not yet show a
  // just-written blob. (A single-page list is fine: ~21 artifacts per tag.)
  const existing = await list({ prefix: `cli/${tag}/`, token });
  const present = new Set(existing.blobs.map((b) => b.pathname));
  if (existing.blobs[0]) storeOrigin = new URL(existing.blobs[0].url).origin;

  // Bind a resume to the commit that first published this tag. `bun build
  // --compile` is not reproducible, so re-running a partially-published tag after
  // the branch moved would mix bytes from two builds, and a resumed tag could get
  // a git tag pointing at a different commit than its binaries. If a prior COMMIT
  // sidecar disagrees with this run's commit, refuse: bump the version instead.
  const releaseCommit = process.env.RELEASE_COMMIT?.trim();
  if (releaseCommit) {
    const commitPath = commitSidecarPath(tag);
    // An unreadable, empty, or mismatched sidecar is a hard refusal: never fail
    // open on this invariant.
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
    // Listed directly: the sidecar lives on the record prefix, so the
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
        // An "already exists" (incl. precondition/ETag) means a prior run wrote
        // it though list() hasn't surfaced it yet. Re-list to get its URL and
        // verify it matches, so a legitimate resume does not crash.
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

  // The signed build record goes to the record prefix, never alongside the
  // downloads: a record the same store write can replace proves nothing the
  // manifest does not. Split out here, where `dist/` becomes an upload list.
  const recordNames = names.filter((name) => name === SIGNATURE_ASSET);
  names = names.filter((name) => name !== SIGNATURE_ASSET);

  // Shared with the edge lane, including the already-published resume rule.
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
    // Not fatal here: phase 2 refuses to advance a pointer without a record, so
    // the only effect is that this tag is not promotable yet.
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

// Phase 2: advance the pointers in `advanceTargets`, only after every immutable
// copy above exists. Each file is server-side copied from its frozen cli/<tag>
// blob rather than re-uploaded from dist/: a resumed re-run rebuilds dist/, and
// `bun build --compile` is not byte-reproducible. Short cache so a release
// propagates in about a minute.
//
// The advance is a non-atomic multi-object copy over a CDN, and a verifying
// consumer cross-checks two objects (SHA256SUMS.txt and a binary), so order
// matters:
//   1. copy every binary first,
//   2. copy the signed record, then SHA256SUMS.txt (the commit point),
//   3. wait until the ring's served URLs are self-consistent to a plain reader
//      (`waitChannelConsistent`),
//   4. copy VERSION last, then wait again. The installed binary's notice reads it
//      without the manifest, so it must never name a release the ring cannot
//      deliver yet.
// So a ring is never reported advanced while a reader could still see a new
// manifest next to a stale binary.
if (advanceTargets.length) {
  if (!names.includes(MANIFEST)) {
    console.error(
      `cli/${tag}/ has no ${MANIFEST} — refusing to advance a channel that can't be consistency-verified.`,
    );
    process.exit(1);
  }

  // The tag's manifest is the source of truth for what a consistent ring must
  // serve. It was just written in phase 1 (or exists already, for --promote), so a
  // transient miss is read-after-write lag, not a real absence: retry a few times
  // before failing.
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

  // A pointer can never name an unsigned file.
  //
  // The consistency barriers below prove the ring serves the same bytes the tag
  // does, not that those bytes came from us: a store writer who replaced the
  // binary and the manifest together would satisfy them. So before any pointer
  // moves, require a signed build record for this tag that covers every object
  // about to be served.
  //
  // A missing record is refused too: "no record yet, advance anyway" is what an
  // attacker would arrange, and what a half-finished release workflow produces.
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
  // The record only vouches for what the manifest lists, so an object the
  // manifest omits is one nothing signed.
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

  // The first barrier certifies the deliverables, before `VERSION` is copied. It
  // still compares against the full manifest (the served `SHA256SUMS.txt` lists
  // `VERSION` too, so a trimmed map would never converge) and only skips reading
  // that one body.
  const hasVersionObject = names.includes(VERSION_OBJECT);
  const deliverableDeps: ConsistencyDeps = {
    ...consistencyDeps,
    skipAssets: new Set([VERSION_OBJECT]),
  };
  // The second barrier reads only `VERSION`: the deliverables were certified
  // moments earlier, and re-hashing ~700 MB of binaries would add minutes to every
  // promote.
  const versionOnlyDeps: ConsistencyDeps = {
    ...consistencyDeps,
    skipAssets: new Set(
      [...expectedSums.keys()].filter((name) => name !== VERSION_OBJECT),
    ),
  };

  for (const target of advanceTargets) {
    // 1) Everything except the manifest and VERSION. Their relative order does
    //    not matter, so copy them concurrently.
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
    //    A new manifest under an old record, or the reverse, makes a client refuse
    //    (fail closed). Adjacent writes keep that window to two small objects, and
    //    keep the manifest as the one commit point.
    const { url: recordUrlCopied } = await copy(
      `${sigPrefixForTag(tag)}/${SIGNATURE_ASSET}`,
      `${sigPrefixForRing(target)}/${SIGNATURE_ASSET}`,
      { access: "public", allowOverwrite: true, cacheControlMaxAge: 60, token },
    );
    console.log(`↝ ${recordUrlCopied} (from ${sigPrefixForTag(tag)}) [record]`);
    // 3) The manifest: the commit point.
    const { url: manifestUrl } = await copy(
      `cli/${tag}/${MANIFEST}`,
      `cli/${target}/${MANIFEST}`,
      { access: "public", allowOverwrite: true, cacheControlMaxAge: 60, token },
    );
    console.log(`↝ ${manifestUrl} (from cli/${tag}) [manifest — commit point]`);
    // 4) Certify the ring is self-consistent to a plain reader before reporting
    //    it advanced (and before the workflow's self-update smoke reads it).
    await waitChannelConsistent(
      `${storeOrigin}/cli/${target}`,
      expectedSums,
      hasVersionObject ? deliverableDeps : consistencyDeps,
    );
    // 5) VERSION last, once the ring can serve what it advertises. The notice
    //    reads VERSION and never the manifest; copied early, it tells the user to
    //    update while `wego update` still reads the old manifest and reports
    //    itself current, and the notice persists that answer for its whole
    //    throttle window (24h on prod). A briefly stale VERSION only delays a
    //    notice.
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
  // Only --freeze advances nothing.
  console.log(
    `\nFroze cli/${tag}/ - no pointer advanced (advance it with --promote after verifying).`,
  );
}
if (storeOrigin) {
  console.log(`STORE_ORIGIN=${storeOrigin}`);
  // The hint names the rings this run advanced, so a `--to stable` promote does
  // not print a cli/next base; stable when nothing advanced (--freeze).
  const hintRings = advanceTargets.length ? advanceTargets : ["stable"];
  console.log("Set on the matching apps/api deploy:");
  for (const ring of hintRings) {
    console.log(`  CLI_DOWNLOAD_BASE_URL=${storeOrigin}/cli/${ring}`);
  }
  // In CI, a step output: the workflow smoke-tests the artifact straight from
  // the store.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `store_origin=${storeOrigin}\n`);
  }
}
