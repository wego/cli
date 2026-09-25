/**
 * The one implementation of "is this release ours?" (foundations#74 rung 9).
 *
 * The publisher, `wego update` and the API's `GET /install?sums=` all answer that
 * question (docs/release.md), and two copies of one trust decision would be two
 * behaviours to reason about.
 *
 * Dependency-free: this is compiled into a published binary that pins its trust
 * root offline and can never be patched in place, so every branch is kept small
 * enough to audit and is tested directly.
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
  type VerifyFailure,
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
