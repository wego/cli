#!/usr/bin/env bun
/**
 * Publish an EDGE build to the public Vercel Blob store and advance the `cli/edge`
 * moving pointer (foundations#74 rung 5 — the edge lane).
 *
 *   BLOB_READ_WRITE_TOKEN=… bun run scripts/publish-edge-blob.ts 0.6.6-edge.abc1234
 *
 * The edge lane is the THIRD ring, beside the two flavor channels
 * (`upload-release-blob.ts`, still live until rung 7's cutover). It exists so every
 * merge to main is published as an installable `X.Y.Z-edge.<sha>` build that
 * `.github/workflows/edge-cli.yml` moves `cli/edge` to — dogfooding unreleased main
 * without touching the release path. A broken edge build blocks nothing: the
 * workflow is post-merge and this script never gates a merge.
 *
 * This is a SEPARATE publisher from `upload-release-blob.ts`, not a new mode of it,
 * because the two worlds differ where it matters:
 *   - edge is ONE ring serving ONE `wego-*` asset (`ring-rules.ts`), where the
 *     flavor path hard-required TWO binary families in dist/;
 *   - edge routes by the version's `-edge.` shape (`ringForVersion`), where the
 *     flavor path routes a plain/prerelease tag to `cli/latest`/`cli/staging`.
 * Keeping them apart means rung 5 touches nothing rung 7 owns, and the flavor
 * publisher's disjoint-channel guards stay exactly as they are.
 *
 * The publish/advance MECHANICS mirror `upload-release-blob.ts` exactly (immutable
 * `cli/<version>/` first, then a server-side copy to `cli/edge` with manifest-last,
 * VERSION-last ordering and the `waitChannelConsistent` barrier between), so the
 * edge channel is never observably manifest-ahead-of-bytes to a plain reader.
 *
 * Env:
 *   BLOB_READ_WRITE_TOKEN  required to publish.
 *   REQUIRE_PUBLISH=true   fail (exit 1) instead of the graceful skip when the token
 *                          is unset — the workflow sets it so a "green" edge run
 *                          can't silently publish nothing.
 *   RELEASE_TAG            fallback version source when no argv is given.
 *   GITHUB_OUTPUT          when set, `store_origin=<origin>` is appended for the
 *                          workflow to read.
 */
import { appendFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { copy, list } from "@vercel/blob";
import {
  FULCIO_ROOTS_PEM,
  identitiesForRing,
  SIGNING_OIDC_ISSUER,
  verifySignedManifest,
} from "../src/release-signing";
import {
  type ConsistencyDeps,
  parseSums,
  waitChannelConsistent,
} from "./blob-consistency";
import { putImmutableAssets, resolveStoreOrigin } from "./blob-publish";
import {
  manifestCoversAll,
  SIGNATURE_ASSET,
  signedRecordRefusal,
  sigPrefixForRing,
  sigPrefixForTag,
} from "./release-signing";
import {
  prefixForRing,
  RELEASE_ASSET_BASENAME,
  ringAcceptsVersion,
  ringForVersion,
} from "./ring-rules";
import { releaseTagError } from "./validate-release-tag";

const MANIFEST = "SHA256SUMS.txt";
const VERSION_OBJECT = "VERSION";

/** The bare `X.Y.Z-edge.<sha>` version this run publishes, or a one-line reason. */
export interface EdgeTarget {
  /** The bare version (`v` stripped) — also the immutable dir name. */
  version: string;
  /** The immutable per-version prefix `cli/<version>`. */
  versionPrefix: string;
  /** The moving ring prefix `cli/edge`. */
  ringPrefix: string;
}

/**
 * Resolve the edge target for a raw version or `v` tag, or a one-line refusal.
 * Pure: no I/O, so the guards are unit-tested without the Blob store.
 *
 * Two gates, both from the shared authorities so this publisher cannot drift:
 *   1. `releaseTagError` — the SAME parser the binary's version comparator uses, so
 *      an edge tag it would reject (`v0.0.0-edge.` with an empty id, a leading
 *      zero) never ships.
 *   2. `ringForVersion === "edge"` — the crossed-pair rule from `ring-rules.ts`: a
 *      plain `X.Y.Z` (which routes to `next`) or an `-rc.*` must never land on edge,
 *      because whatever the ring serves is what its install base receives next.
 */
export function resolveEdgeTarget(raw: string): EdgeTarget | { error: string } {
  const version = raw.replace(/^v/, "");
  const tagError = releaseTagError(`v${version}`);
  if (tagError) return { error: tagError };
  if (ringForVersion(version) !== "edge") {
    // `ringAcceptsVersion` phrases the edge-specific refusal.
    const reason =
      ringAcceptsVersion("edge", version) ?? `${version} is not an edge build.`;
    return { error: reason };
  }
  return {
    version,
    versionPrefix: `cli/${version}`,
    ringPrefix: prefixForRing("edge"),
  };
}

if (import.meta.main) {
  const raw = process.argv[2] ?? process.env.RELEASE_TAG;
  if (!raw) {
    console.error(
      "usage: publish-edge-blob.ts <X.Y.Z-edge.<sha>>   # publish + advance cli/edge",
    );
    process.exit(1);
  }

  const resolved = resolveEdgeTarget(raw);
  if ("error" in resolved) {
    console.error(`Refusing to publish edge: ${resolved.error}`);
    process.exit(1);
  }
  const { version, versionPrefix, ringPrefix } = resolved;

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    const msg =
      "BLOB_READ_WRITE_TOKEN unset – no Blob store to publish the edge build to.";
    if (process.env.REQUIRE_PUBLISH === "true") {
      console.error(`${msg} REQUIRE_PUBLISH is set – failing the edge run.`);
      process.exit(1);
    }
    console.warn(`${msg} Skipping (edge is dogfood-only and blocks nothing).`);
    process.exit(0);
  }

  const distDir = "dist";
  const allNames = await readdir(distDir);
  // The signed build record goes to the RECORD prefix, never beside the downloads
  // (foundations#74 rung 9) — a record the same store write can replace proves
  // nothing. Split here, at the one place `dist/` becomes an upload list.
  const recordNames = allNames.filter((n) => n === SIGNATURE_ASSET);
  const names = allNames.filter((n) => n !== SIGNATURE_ASSET);
  if (names.length === 0) {
    console.error(
      `No artifacts in ${distDir}/ – run \`bun run scripts/build-release.ts\` first.`,
    );
    process.exit(1);
  }

  // Edge serves ONE `wego-*` asset (the target axis picks the backend at run time,
  // so the flavor is never in the filename). Refuse a retired-flavor build — that
  // is the flavor world's asset and must never reach the ring model's pointer.
  if (!names.includes(MANIFEST)) {
    console.error(`dist/ has no ${MANIFEST} – cannot verify the edge channel.`);
    process.exit(1);
  }
  if (recordNames.length === 0) {
    console.error(
      `dist/ carries no ${SIGNATURE_ASSET} - refusing to advance cli/edge onto an unsigned build. ` +
        "A binary built from this same main refuses a ring with no record, so publishing " +
        "one would break `wego update` for every edge install.",
    );
    process.exit(1);
  }
  if (!names.includes(VERSION_OBJECT)) {
    console.error(
      `dist/ has no ${VERSION_OBJECT} – cannot advertise the edge version.`,
    );
    process.exit(1);
  }
  const publishedVersion = (
    await readFile(join(distDir, VERSION_OBJECT), "utf8")
  ).trim();
  if (publishedVersion !== version) {
    console.error(
      `dist/${VERSION_OBJECT} is ${publishedVersion}, but this run publishes ${version} – refusing a mismatched advertisement.`,
    );
    process.exit(1);
  }
  const binaries = names.filter((n) => n !== MANIFEST && n !== VERSION_OBJECT);
  if (!binaries.some((n) => n.startsWith(`${RELEASE_ASSET_BASENAME}-`))) {
    console.error(
      `dist/ carries no ${RELEASE_ASSET_BASENAME}-* binary – the edge ring serves the one ${RELEASE_ASSET_BASENAME}-* asset.`,
    );
    process.exit(1);
  }
  const wrongFlavor = binaries.filter(
    (n) => !n.startsWith(`${RELEASE_ASSET_BASENAME}-`),
  );
  if (wrongFlavor.length > 0) {
    console.error(
      `dist/ carries non-${RELEASE_ASSET_BASENAME} assets (${wrongFlavor.join(", ")}) – the edge ring serves only ${RELEASE_ASSET_BASENAME}-* (build with \`build-release.ts\`).`,
    );
    process.exit(1);
  }

  // Phase 1 — immutable versioned copies (cached hard), idempotent on a resume.
  const existing = await list({ prefix: `${versionPrefix}/`, token });
  const present = new Set(existing.blobs.map((b) => b.pathname));
  let storeOrigin = existing.blobs[0]
    ? new URL(existing.blobs[0].url).origin
    : "";
  storeOrigin = await putImmutableAssets({
    names,
    distDir,
    prefix: versionPrefix,
    present,
    token,
    storeOrigin,
  });
  storeOrigin = await putImmutableAssets({
    names: recordNames,
    distDir,
    prefix: sigPrefixForTag(version),
    present,
    token,
    storeOrigin,
  });
  // A fully-resumed run uploads nothing, so the origin can still be unknown here
  // (see `resolveStoreOrigin`). Recover it before it reaches the manifest URL.
  storeOrigin = await resolveStoreOrigin({
    storeOrigin,
    prefix: versionPrefix,
    token,
  });
  if (!storeOrigin) {
    console.error(
      `Cannot determine the Blob store origin for ${versionPrefix}/ – nothing was uploaded and the prefix lists no blobs, so there is no channel to certify.`,
    );
    process.exit(1);
  }

  // Phase 2 — advance cli/edge from the frozen version dir. Same ordering as
  // `upload-release-blob.ts`: binaries first, manifest (commit point) next, certify,
  // then VERSION last and certify again — so a reader never sees a new manifest next
  // to a stale binary, nor a VERSION advertising bytes the channel cannot serve.
  const tagSumsUrl = `${storeOrigin}/${versionPrefix}/${MANIFEST}`;
  const readTagSums = async (attempts = 5): Promise<string> => {
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(tagSumsUrl, {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return await res.text();
        console.warn(
          `${versionPrefix}/${MANIFEST} → HTTP ${res.status} (attempt ${i}/${attempts}; read-after-write lag?)`,
        );
      } catch (err) {
        console.warn(
          `${versionPrefix}/${MANIFEST} fetch failed (attempt ${i}/${attempts}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (i < attempts) await Bun.sleep(2_000);
    }
    return "";
  };
  const tagSumsText = await readTagSums();
  if (!tagSumsText) {
    console.error(
      `Cannot read ${versionPrefix}/${MANIFEST} after retries – needed to certify channel consistency.`,
    );
    process.exit(1);
  }
  const expectedSums = parseSums(tagSumsText);
  if (expectedSums.size === 0) {
    console.error(
      `${versionPrefix}/${MANIFEST} lists no assets – refusing to advance an unverifiable channel.`,
    );
    process.exit(1);
  }

  // The record must VOUCH for this manifest, not merely exist (foundations#74 rung
  // 9). Presence was checked in phase 1 against `dist/`; that catches a build with
  // no record but nothing else — a record covering different bytes, or carrying the
  // RELEASE lane's identity rather than the edge lane's, would still have advanced
  // `cli/edge`, and every edge client would then refuse to update from it. The
  // release publisher has always gated here; the edge lane claimed the same gate in
  // two AGENTS.md files without doing it.
  //
  // Read from the STORE, not from `dist/`: what has to be vouched for is the bytes
  // the ring will actually serve.
  const edgeRecordUrl = `${storeOrigin}/${sigPrefixForTag(version)}/${SIGNATURE_ASSET}`;
  const edgeRecordRes = await fetch(edgeRecordUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  }).catch((err: unknown) => {
    console.error(
      `Cannot read ${edgeRecordUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });
  if (!edgeRecordRes?.ok) {
    console.error(
      `No signed build record at ${edgeRecordUrl}` +
        (edgeRecordRes ? ` (HTTP ${edgeRecordRes.status})` : "") +
        " - refusing to advance cli/edge onto an unsigned build.",
    );
    process.exit(1);
  }
  let edgeRecord: unknown;
  try {
    edgeRecord = JSON.parse(await edgeRecordRes.text());
  } catch {
    console.error(
      `The signed build record at ${edgeRecordUrl} is not JSON - refusing to advance.`,
    );
    process.exit(1);
  }
  const edgeVerdict = await verifySignedManifest({
    bundle: edgeRecord,
    payload: new TextEncoder().encode(tagSumsText),
    identity: identitiesForRing("edge"),
    issuer: SIGNING_OIDC_ISSUER,
    rootsPem: FULCIO_ROOTS_PEM,
  });
  if (!edgeVerdict.ok) {
    console.error(
      signedRecordRefusal(
        `${versionPrefix}/${MANIFEST}`,
        "edge",
        edgeVerdict.reason,
      ),
    );
    process.exit(1);
  }
  // …and a record only vouches for what the manifest LISTS, so an object the
  // manifest omits is an object nothing signed.
  const edgeCoverage = manifestCoversAll(tagSumsText, names);
  if (edgeCoverage) {
    console.error(`Refusing to advance cli/edge: ${edgeCoverage}`);
    process.exit(1);
  }

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
  const deliverableDeps: ConsistencyDeps = {
    ...consistencyDeps,
    skipAssets: new Set([VERSION_OBJECT]),
  };
  const versionOnlyDeps: ConsistencyDeps = {
    ...consistencyDeps,
    skipAssets: new Set(
      [...expectedSums.keys()].filter((name) => name !== VERSION_OBJECT),
    ),
  };

  // 1) Binaries first (order among them is irrelevant), 2) manifest last.
  await Promise.all(
    names
      .filter((name) => name !== MANIFEST && name !== VERSION_OBJECT)
      .map(async (name) => {
        const { url } = await copy(
          `${versionPrefix}/${name}`,
          `${ringPrefix}/${name}`,
          {
            access: "public",
            allowOverwrite: true,
            cacheControlMaxAge: 60,
            token,
          },
        );
        console.log(`↝ ${url} (from ${versionPrefix})`);
      }),
  );
  // The record first, then the manifest it vouches for. Both orders leave a brief
  // window where a client sees a mismatched pair and REFUSES - fail-closed either
  // way - so keep the two writes adjacent and the manifest last, which is the commit
  // point everything else is ordered around (foundations#74 rung 9).
  const { url: recordUrl } = await copy(
    `${sigPrefixForTag(version)}/${SIGNATURE_ASSET}`,
    `${sigPrefixForRing("edge")}/${SIGNATURE_ASSET}`,
    { access: "public", allowOverwrite: true, cacheControlMaxAge: 60, token },
  );
  console.log(`↝ ${recordUrl} [record]`);
  const { url: manifestUrl } = await copy(
    `${versionPrefix}/${MANIFEST}`,
    `${ringPrefix}/${MANIFEST}`,
    { access: "public", allowOverwrite: true, cacheControlMaxAge: 60, token },
  );
  console.log(
    `↝ ${manifestUrl} (from ${versionPrefix}) [manifest – commit point]`,
  );
  // 3) Certify the deliverable channel before advertising VERSION.
  await waitChannelConsistent(
    `${storeOrigin}/${ringPrefix}`,
    expectedSums,
    deliverableDeps,
  );
  // 4) VERSION strictly last, then certify again reading it.
  const { url: versionUrl } = await copy(
    `${versionPrefix}/${VERSION_OBJECT}`,
    `${ringPrefix}/${VERSION_OBJECT}`,
    { access: "public", allowOverwrite: true, cacheControlMaxAge: 60, token },
  );
  console.log(
    `↝ ${versionUrl} (from ${versionPrefix}) [VERSION – advertised after the commit point]`,
  );
  await waitChannelConsistent(
    `${storeOrigin}/${ringPrefix}`,
    expectedSums,
    versionOnlyDeps,
  );

  console.log(
    `\nAdvanced ${ringPrefix} to ${version} (copied from ${versionPrefix}).`,
  );
  if (storeOrigin) {
    console.log(`STORE_ORIGIN=${storeOrigin}`);
    console.log(`Edge base: ${storeOrigin}/${ringPrefix}`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `store_origin=${storeOrigin}\n`,
      );
    }
  }
}
