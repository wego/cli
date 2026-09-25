/**
 * Harvest the signing identities `identity.ts` must trust from real published
 * records (wego/foundations#129).
 *
 * Why a script and not hand-typed strings: `verifySignedManifest` accepts a
 * record iff its leaf certificate's SAN matches one of these rules, so a typo
 * either locks every client out of updates or, worse, silently widens what a
 * client accepts. The strings are long, nearly identical, and differ from the
 * wego-ai ones by one path segment, which is easy to transcribe wrong and to
 * miss in review.
 *
 * This script downloads the two records the lanes published, reads the SAN from
 * each leaf certificate with the same parser the binary verifies with
 * (`parseCertificate`), and emits the rules.
 *
 * Every field that carries authority is asserted, not trusted: the OIDC issuer,
 * owner/repo, workflow filename and ref shape. An unexpected value fails with
 * the mismatch printed. Only the version in the tag ref becomes a pattern,
 * because `wego update` reads a ring and cannot know which release is behind
 * it; everything else stays a literal taken from the record.
 *
 * USAGE
 *
 *   STORE_ORIGIN=https://<id>.public.blob.vercel-storage.com \
 *     bun run scripts/extract-identities.ts --tag v1.0.2 --edge 0.0.0-edge.b6e6e7c
 *
 *   --tag <vX.Y.Z>      the release tag whose record supplies the next/stable rule
 *   --edge <version>    the edge build version whose record supplies the edge rule
 *   --store <origin>    overrides STORE_ORIGIN
 *
 * Prints the two rules as TypeScript to paste into `identity.ts`. It does not
 * edit the file, so the resulting diff is what a human reviews.
 */

import {
  SIGNATURE_ASSET,
  SIGNING_OIDC_ISSUER,
} from "../src/release-signing/identity";
import { parseCertificate } from "../src/release-signing/x509";

/** Asserted rather than read off the record, so a record from another
 *  repository fails loudly instead of being emitted as a trusted rule. */
export const EXPECTED_REPO = "wego/cli";

/** `release-cli.yml` signs what `next` and `stable` serve; `edge-cli.yml` signs
 *  what `edge` serves. */
export const RELEASE_WORKFLOW = "release-cli.yml";
export const EDGE_WORKFLOW = "edge-cli.yml";

/** The edge lane triggers only on main, so this is a literal, not a pattern. */
export const EDGE_REF = "refs/heads/main";

/**
 * `workflow` stops at the `@` and `ref` takes the rest, so a ref containing an
 * `@` cannot eat into the workflow name. Anchored at both ends so a SAN that
 * merely contains a legitimate identity does not parse as one.
 */
const SAN_SHAPE =
  /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/\.github\/workflows\/(?<workflow>[^@/]+)@(?<ref>.+)$/;

/** A plain release tag ref. There are no `-rc.N` releases, so a prerelease
 *  suffix is not a release identity. */
const TAG_REF_SHAPE = /^refs\/tags\/v\d+\.\d+\.\d+$/;

export interface SanParts {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
}

export function parseSan(san: string): SanParts {
  const m = SAN_SHAPE.exec(san);
  if (!m?.groups) {
    throw new Error(
      `SAN is not a GitHub Actions workflow identity: ${san}\n` +
        `expected https://github.com/<owner>/<repo>/.github/workflows/<file>@<ref>`,
    );
  }
  const { owner, repo, workflow, ref } = m.groups;
  return {
    owner: owner as string,
    repo: repo as string,
    workflow: workflow as string,
    ref: ref as string,
  };
}

/**
 * The SAN URI from a Sigstore bundle's leaf certificate, via the same parser the
 * binary verifies with.
 *
 * `v0.3` bundles carry a single `certificate`; `v0.2` and earlier carry an
 * `x509CertificateChain` whose first entry is the leaf. Both are read so an
 * older record in the store is not missed; anything else throws.
 *
 * A leaf with zero or several SAN URIs is refused: Fulcio issues exactly one for
 * a workflow identity, and picking one of several would be choosing which
 * identity to trust.
 */
export function sanFromBundle(bundle: unknown): string {
  const vm = (bundle as { verificationMaterial?: Record<string, unknown> })
    ?.verificationMaterial;
  if (!vm) throw new Error("bundle has no verificationMaterial");

  const single = (vm.certificate as { rawBytes?: string } | undefined)
    ?.rawBytes;
  const chained = (
    vm.x509CertificateChain as
      | { certificates?: { rawBytes?: string }[] }
      | undefined
  )?.certificates?.[0]?.rawBytes;
  const rawBytes = single ?? chained;
  if (!rawBytes) {
    throw new Error(
      "bundle carries no leaf certificate " +
        "(neither verificationMaterial.certificate nor .x509CertificateChain)",
    );
  }

  const der = Uint8Array.from(Buffer.from(rawBytes, "base64"));
  const cert = parseCertificate(der as Uint8Array<ArrayBuffer>);

  if (cert.oidcIssuer !== SIGNING_OIDC_ISSUER) {
    throw new Error(
      `record was signed under OIDC issuer ${cert.oidcIssuer ?? "(none)"}, ` +
        `not ${SIGNING_OIDC_ISSUER}. Refusing: without the issuer pinned, any ` +
        `issuer Fulcio trusts could assert the same SAN string.`,
    );
  }
  if (cert.sanUris.length !== 1) {
    throw new Error(
      `leaf certificate carries ${cert.sanUris.length} SAN URIs, expected exactly 1: ` +
        JSON.stringify(cert.sanUris),
    );
  }
  return cert.sanUris[0] as string;
}

function assertParts(
  san: string,
  want: { workflow: string },
  label: string,
): SanParts {
  const parts = parseSan(san);
  const repo = `${parts.owner}/${parts.repo}`;
  if (repo !== EXPECTED_REPO) {
    throw new Error(
      `${label} record names repository ${repo}, expected ${EXPECTED_REPO}: ${san}`,
    );
  }
  if (parts.workflow !== want.workflow) {
    throw new Error(
      `${label} record names workflow ${parts.workflow}, expected ${want.workflow}: ${san}`,
    );
  }
  return parts;
}

function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export interface IdentityRules {
  /** The exact SAN an edge record carries, emitted verbatim. */
  edge: string;
  tagSan: string;
  /** `RegExp` source generalising only the version in the tag ref. */
  tagPattern: string;
}

/**
 * The edge rule is the SAN itself, since the ref is fixed. The tag rule replaces
 * only the version: everything before `refs/tags/v` is escaped and kept verbatim,
 * so the repo, workflow file and ref prefix remain literals from a real
 * certificate.
 */
export function identityRulesFrom(
  tagSan: string,
  edgeSan: string,
): IdentityRules {
  const edge = assertParts(edgeSan, { workflow: EDGE_WORKFLOW }, "edge");
  if (edge.ref !== EDGE_REF) {
    throw new Error(
      `edge record names ref ${edge.ref}, expected ${EDGE_REF}: ${edgeSan}`,
    );
  }

  const tag = assertParts(tagSan, { workflow: RELEASE_WORKFLOW }, "release");
  if (!TAG_REF_SHAPE.test(tag.ref)) {
    throw new Error(
      `release record names ref ${tag.ref}, expected refs/tags/vX.Y.Z ` +
        `(a plain version — the -rc.N line is gone, #74 rung 7): ${tagSan}`,
    );
  }

  const prefix = tagSan.slice(
    0,
    tagSan.lastIndexOf("refs/tags/v") + "refs/tags/v".length,
  );
  return {
    edge: edgeSan,
    tagSan,
    tagPattern: `^${escapeRe(prefix)}\\d+\\.\\d+\\.\\d+$`,
  };
}

export function renderRules(rules: IdentityRules): string {
  return [
    "export const CLI_RELEASE_TAG_IDENTITY =",
    `  /${rules.tagPattern}/;`,
    "",
    "export const CLI_EDGE_SIGNING_IDENTITY =",
    `  ${JSON.stringify(rules.edge)};`,
  ].join("\n");
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function fetchBundle(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as unknown;
}

async function main(): Promise<void> {
  const store = (arg("--store") ?? process.env.STORE_ORIGIN ?? "").replace(
    /\/+$/,
    "",
  );
  const tag = arg("--tag");
  const edge = arg("--edge");

  if (!store || !tag || !edge) {
    console.error(
      "usage: STORE_ORIGIN=<origin> bun run scripts/extract-identities.ts " +
        "--tag <vX.Y.Z> --edge <edge-version>\n" +
        "  reads cli-sig/<tag>/ and cli-sig/<edge-version>/ from the store",
    );
    process.exit(2);
  }

  const tagUrl = `${store}/cli-sig/${tag}/${SIGNATURE_ASSET}`;
  const edgeUrl = `${store}/cli-sig/${edge}/${SIGNATURE_ASSET}`;

  console.error(`reading ${tagUrl}`);
  console.error(`reading ${edgeUrl}`);

  const [tagSan, edgeSan] = await Promise.all([
    fetchBundle(tagUrl).then(sanFromBundle),
    fetchBundle(edgeUrl).then(sanFromBundle),
  ]);

  console.error(`release SAN  ${tagSan}`);
  console.error(`edge SAN     ${edgeSan}`);

  console.log(renderRules(identityRulesFrom(tagSan, edgeSan)));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
