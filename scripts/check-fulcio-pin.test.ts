/**
 * `check-fulcio-pin.ts` does one `fetch` behind `import.meta.main`; the
 * comparison logic is in two pure functions, so that is what is tested.
 *
 * A reformatting of the same certificates must not alarm (or the weekly job
 * becomes noise and gets muted, and a real rotation is missed), and a genuine
 * change in the set must always alarm.
 */
import { describe, expect, it } from "bun:test";
import { certificateBodies, pinDrift } from "./check-fulcio-pin";

const A = "AAAABBBBCCCC";
const B = "DDDDEEEEFFFF";
const pem = (...bodies: string[]) =>
  bodies
    .map((b) => `-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----`)
    .join("\n\n");

describe("certificateBodies", () => {
  it("reads every certificate in a bundle", () => {
    expect(certificateBodies(pem(A, B))).toEqual([A, B].sort());
  });

  it("ignores line wrapping and surrounding whitespace", () => {
    const wrapped = `-----BEGIN CERTIFICATE-----\n  ${A.slice(0, 4)}\n${A.slice(4)}  \n-----END CERTIFICATE-----\n`;
    expect(certificateBodies(wrapped)).toEqual([A]);
  });

  it("is order-insensitive", () => {
    expect(certificateBodies(pem(A, B))).toEqual(certificateBodies(pem(B, A)));
  });

  it("reads nothing out of an empty or headerless body", () => {
    expect(certificateBodies("")).toEqual([]);
    expect(certificateBodies("not a pem file")).toEqual([]);
  });
});

describe("pinDrift", () => {
  it("passes when the same certificates are served, in any order", () => {
    expect(pinDrift(pem(A, B), pem(B, A))).toBeNull();
  });

  it("reports a certificate served but not pinned", () => {
    const drift = pinDrift(pem(A), pem(A, B));
    expect(drift).toContain("1 certificate(s) served but not pinned");
  });

  it("reports a certificate pinned but no longer served", () => {
    const drift = pinDrift(pem(A, B), pem(A));
    expect(drift).toContain("1 pinned but no longer served");
  });

  // An empty answer (a truncated response, a proxy, an endpoint that moved)
  // must alarm, or the check passes having compared the pin against nothing.
  it("refuses to read an empty bundle as agreement", () => {
    const drift = pinDrift(pem(A, B), "");
    expect(drift).toContain("no certificates");
  });

  // It fires rarely, to someone who has never seen it, about a failure with no
  // other symptom, so the message has to explain itself.
  it("explains the consequence and the fix", () => {
    const drift = pinDrift(pem(A), pem(B)) ?? "";
    expect(drift).toContain("sigstore-roots.ts");
    expect(drift).toContain("rollback horizon");
  });
});
