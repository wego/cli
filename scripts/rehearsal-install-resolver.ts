/**
 * PHASE 1 REHEARSAL SCAFFOLDING (wego/foundations#128). Delete this file, its
 * step in `release-cli.yml` and the `SMOKE_INSTALL_URL` variable at cutover.
 *
 * WHY THIS EXISTS.
 *
 * SMOKE 3 proves a predecessor can self-update onto the ring this run just
 * advanced. The predecessor resolves its download through the `/install`
 * endpoint recorded in its install record — in production, `api.wego.com`,
 * whose `CLI_DOWNLOAD_BASE_URL` names the PRODUCTION store. That is exactly the
 * store a rehearsal must not touch, so the rehearsal needs an `/install` that
 * resolves into the rehearsal store instead.
 *
 * The obvious answer — a non-production deployment of `apps/api` whose
 * `CLI_DOWNLOAD_BASE_URL` names the rehearsal store — does not work, and the
 * reason is in this repository rather than in Vercel. Every preview deployment
 * sits behind Vercel Authentication, and the binary cannot get past it:
 * `update.ts` passes `fetch` nothing but a timeout signal, so it can send no
 * `x-vercel-protection-bypass` header, and `ring-follow.ts` rejects a query
 * string on `installUrl` and then rebuilds the URL as `${origin}/install`, so
 * the documented query-parameter form of the bypass cannot survive either.
 * Making it reach a preview would take a CLI change, which Phase 1 forbids.
 *
 * WHAT THIS IS.
 *
 * The API's contract for this path is a pure, stateless redirect:
 *
 *     GET /install?dl=<asset>&ring=<ring>         ->  302  <store>/cli/<ring>/<asset>
 *     GET /install?dl=<asset>&ring=<ring>&sig=1   ->  302  <store>/cli-sig/<ring>/<asset>
 *
 * verified against production across `VERSION`, `SHA256SUMS.txt`, a `.gz`
 * binary, `COMMIT` and the ring record. `assertSecureUrl` (src/config.ts)
 * allows plaintext on loopback, so a redirector on `127.0.0.1` is a faithful
 * stand-in for that one hop.
 *
 * The `sig=1` line was MISSING until wego/foundations#129. The original note here
 * claimed the `?dl=` form covered the contract "with no exceptions", because the
 * four assets it was checked against are all downloads — and `wego update`'s
 * record fetch, the one thing rung 9 exists for, is not a download. The omission
 * could not surface until a run got past the identity gate and actually reached
 * SMOKE 3, which first happened in release run 34588318406.
 *
 * It PROXIES NOTHING. The 302 sends the binary straight to the real store over
 * public HTTPS, so the download, the checksum comparison, the signature check
 * against `identitiesForRing("next")` and the binary swap are all exactly what
 * a production self-update does. The only synthesized step is the redirect.
 *
 * WHAT IT DELIBERATELY CANNOT DO.
 *
 * The store is not configurable here: the lane passes
 * `steps.publish.outputs.store_origin`, the store THIS RUN published to. A
 * rehearsal can therefore never read a store its own run did not write, which
 * is the property the preview design was reaching for and the reason this is
 * not simply a hardcoded rehearsal URL.
 *
 * THE TWO ROUTES ADDED FOR THE MANUAL INSTALL (wego/foundations#129, amended
 * 2026-09-11).
 *
 * The above was scoped for SMOKE 3, which writes `install.json` itself via
 * `--install-url` and so only ever asks for `?dl=`. A HUMAN install — `curl
 * .../install | bash` — needs two more things, and there is no preview API to
 * serve them (staging has no `/install` route at all):
 *
 *   GET /install                  -> the REAL production installer script,
 *                                    re-pointed at this resolver and at the
 *                                    ring under test
 *   GET /install?sums=1&ring=<r>  -> 302  <store>/cli/<r>/SHA256SUMS.txt
 *
 * Serving the genuine script rather than a stand-in is the point: the rehearsal
 * then exercises the real checksum fetch, the real `.gz` fallback, the real ring
 * recording and the real skill install against rehearsal bytes. It is fetched
 * once from production and rewritten in memory — never vendored, so it cannot
 * drift from what a real user runs.
 *
 * ONE DELIBERATE DIVERGENCE FROM PRODUCTION, and it is not a small one.
 *
 * In production `?sums=` is NOT a redirect. `apps/api` hands back the manifest
 * only after it has checked the ring's SIGNED BUILD RECORD over it (the
 * installer's own comment at the `?sums=` fetch says so, and rung 9 is the
 * reason): a `sh` installer cannot verify a Sigstore bundle, so the host does it
 * for the installer. This resolver cannot — it holds no store credentials and
 * implements no verification — so it 302s the manifest straight out of the
 * store, exactly as the amendment specifies.
 *
 * What that costs, precisely: the INSTALL's checksums are unvouched-for here, so
 * a fresh install proves the ring recording and the download path, not rung 9.
 * What it does NOT cost: `wego update` verifies the record itself, in the
 * binary, against `identitiesForRing` — so the self-update half of the rehearsal,
 * which is the half #129 is actually proving, keeps its full signature check.
 * Do not copy this branch into anything that faces a user.
 */

import { MANIFEST_ASSET } from "../src/release-signing/identity";

/** Asset and ring names as the store spells them. Deliberately strict: this
 *  builds a URL path, and `ring-follow.ts` refuses dot segments on the client
 *  side for the same reason. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `${name} is required. This resolver is started by release-cli.yml, which ` +
        `passes the store origin it published to and the port named by ` +
        `SMOKE_INSTALL_URL.`,
    );
    process.exit(2);
  }
  return value;
}

const storeOrigin = requireEnv("STORE_ORIGIN").replace(/\/+$/, "");
const port = Number(requireEnv("PORT"));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a TCP port, got "${process.env.PORT}".`);
  process.exit(2);
}

/** The ring a bare `/install` installs from. Only the SCRIPT route needs it —
 *  `?dl=`/`?sums=` take the ring from the query, as production does. `stable` is
 *  the production default and stays the default here so the rewrite below is a
 *  no-op when nothing is set. */
const ring = (process.env.RING ?? "stable").trim();
if (!SAFE_SEGMENT.test(ring)) {
  console.error(`RING must be a plain path segment, got "${ring}".`);
  process.exit(2);
}

/** Where the genuine installer is served from. Fetched, never vendored: a copy
 *  in this repo would drift from what a real user runs, and the whole point of
 *  this route is that the rehearsal exercises the real script. */
const UPSTREAM_INSTALLER = "https://api.wego.com/install";

/** The literals the rewrite replaces, each with the number of hits it must find.
 *  Asserted rather than best-effort: if the upstream installer is reworked and a
 *  literal moves, this resolver must FAIL rather than quietly serve a script
 *  that still points at production — which, on a `?dl=`, means the production
 *  STORE. Counts measured against the live script on 2026-09-11. */
const REWRITES: { find: RegExp; replace: string; hits: number }[] = [
  // Line 3. Every request the script makes is built from $BASE, so this one
  // substitution is what moves the whole install onto the loopback resolver.
  {
    find: /^BASE='https:\/\/api\.wego\.com\/install'$/m,
    replace: `BASE='http://127.0.0.1:${port}/install'`,
    hits: 1,
  },
  // The hardcoded ring in the three asset/manifest fetches.
  { find: /ring=stable/g, replace: `ring=${ring}`, hits: 3 },
  // ...and in the value written into install.json, which is what `wego update`
  // reads. Getting this one wrong would leave the binary following `stable`.
  { find: /^RING='stable'$/m, replace: `RING='${ring}'`, hits: 1 },
];

let installerScript: string | undefined;

/** The production installer, re-pointed at this resolver and at the ring under
 *  test. Fetched once and memoised for the life of the process. */
async function rewrittenInstaller(): Promise<string> {
  if (installerScript !== undefined) return installerScript;

  const res = await fetch(UPSTREAM_INSTALLER);
  if (!res.ok) {
    throw new Error(
      `GET ${UPSTREAM_INSTALLER} -> ${res.status} ${res.statusText}`,
    );
  }
  let script = await res.text();

  for (const { find, replace, hits } of REWRITES) {
    const found = script.match(find)?.length ?? 0;
    if (found !== hits) {
      throw new Error(
        `installer rewrite ${find} matched ${found} times, expected ${hits}. ` +
          `The upstream installer changed shape; re-measure before trusting ` +
          `this route — an un-rewritten literal points a rehearsal install at ` +
          `the PRODUCTION store.`,
      );
    }
    script = script.replace(find, replace);
  }

  // Belt and braces: nothing may still name production. A rewrite that silently
  // stopped matching is the one failure mode that would be invisible otherwise.
  if (script.includes("api.wego.com")) {
    throw new Error(
      "rewritten installer still references api.wego.com — refusing to serve it",
    );
  }

  installerScript = script;
  return script;
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname !== "/install") {
      return new Response(
        "only /install, /install?dl=<asset>&ring=<ring> and " +
          "/install?sums=1&ring=<ring> are served\n",
        { status: 404 },
      );
    }

    const dl = url.searchParams.get("dl");
    const sums = url.searchParams.get("sums");

    // A bare `/install` is the shell installer a human pipes into `bash`.
    if (!dl && !sums) {
      try {
        const script = await rewrittenInstaller();
        console.log(`200 ${url.pathname} -> installer (ring=${ring})`);
        return new Response(script, {
          headers: { "content-type": "text/x-shellscript; charset=utf-8" },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`500 ${url.pathname} -> ${message}`);
        return new Response(`${message}\n`, { status: 500 });
      }
    }

    // `?sums=1` names no asset: the manifest is always SHA256SUMS.txt. See the
    // divergence note in the header — production verifies the ring's signed
    // build record before serving this; a redirector cannot.
    const asset = sums ? MANIFEST_ASSET : dl;
    const queryRing = url.searchParams.get("ring");

    // `&sig=1` selects the RECORD prefix, not the download prefix. This is not a
    // variant spelling of `?dl=` — it is the other half of rung 9. `cli-sig/<ring>`
    // is deliberately a separate top-level prefix from `cli/<ring>` (see
    // `sigPrefixForRing`), because a record stored beside the manifest it signs
    // falls to the same store write it exists to detect. `ring-follow.ts`'s
    // `ringRecordUrl` appends it, and production honours it:
    //
    //   ?dl=SHA256SUMS.txt.sigstore.json&ring=stable         -> cli/stable/…
    //   ?dl=SHA256SUMS.txt.sigstore.json&ring=stable&sig=1    -> cli-sig/stable/…
    //
    // Without this, `wego update` asks for the ring's record, is pointed into the
    // download prefix, gets a 404 and refuses to update — which is exactly how
    // SMOKE 3 failed in release run 34588318406.
    const prefix = url.searchParams.get("sig") === "1" ? "cli-sig" : "cli";
    if (!asset || !queryRing) {
      return new Response(
        "ring is required, with either dl=<asset> or sums=1\n",
        { status: 400 },
      );
    }
    if (!SAFE_SEGMENT.test(asset) || !SAFE_SEGMENT.test(queryRing)) {
      return new Response("dl and ring must be plain path segments\n", {
        status: 400,
      });
    }

    const target = `${storeOrigin}/${prefix}/${queryRing}/${asset}`;
    // Logged so the run's own output shows what the smoke resolved, which is
    // the first thing anyone reads when a rehearsal self-update goes wrong.
    console.log(`302 ${url.pathname}${url.search} -> ${target}`);
    return Response.redirect(target, 302);
  },
});

console.log(
  `rehearsal install resolver on http://127.0.0.1:${port}/install\n` +
    `  GET /install                  the production installer, re-pointed here, ring=${ring}\n` +
    `  GET /install?sums=1&ring=<r>  302 -> ${storeOrigin}/cli/<r>/${MANIFEST_ASSET}\n` +
    `  GET /install?dl=<a>&ring=<r>  302 -> ${storeOrigin}/cli/<r>/<a>`,
);
