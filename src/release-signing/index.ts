/**
 * `@wego/release-signing` — the one implementation of "is this release ours?"
 * (foundations#74 rung 9).
 *
 * Both ends of the release path have to answer that question: `apps/cli`'s
 * `wego update`, before it replaces the running binary, and `apps/api`'s
 * `GET /install?sums=`, before it hands an installer a manifest. Two copies of one
 * trust decision is two behaviours to reason about, so there is one — here.
 *
 * A `packages/*` workspace rather than a copy in each app, which is what
 * `apps/api/AGENTS.md` prescribes for code two apps genuinely share: *"if cross-app
 * sharing is ever needed, extract a `packages/*` workspace"*. The apps stay
 * self-contained in the sense that rule protects — neither reaches into the other.
 *
 * Deliberately **dependency-free**. This is compiled into a published binary that
 * pins its trust root offline and can never be patched in place, so every branch is
 * kept small enough to audit and is tested directly.
 */
export { DerError } from "./der";
export {
  CLI_EDGE_SIGNING_IDENTITY,
  CLI_RELEASE_TAG_IDENTITY,
  EDGE_SIGNING_IDENTITY,
  type IdentityRule,
  identitiesForRing,
  MANIFEST_ASSET,
  RELEASE_TAG_IDENTITY,
  SIGNATURE_ASSET,
  SIGNING_IDENTITY,
  SIGNING_OIDC_ISSUER,
} from "./identity";
export {
  type VerifyInput,
  type VerifyResult,
  verifySignedManifest,
} from "./signature";
export { FULCIO_ROOTS_PEM } from "./sigstore-roots";
export {
  type Certificate,
  ecdsaDerToRaw,
  parseCertificate,
  pemToDer,
  sameName,
} from "./x509";
