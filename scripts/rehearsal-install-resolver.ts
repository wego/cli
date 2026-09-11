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
 * The API's entire contract for this path is a pure, stateless redirect:
 *
 *     GET /install?dl=<asset>&ring=<ring>  ->  302  <store>/cli/<ring>/<asset>
 *
 * verified against production across `VERSION`, `SHA256SUMS.txt`, a `.gz`
 * binary and `COMMIT`, with no exceptions. `assertSecureUrl` (src/config.ts)
 * allows plaintext on loopback, so a redirector on `127.0.0.1` is a faithful
 * stand-in for that one hop.
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
 */

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

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);

    // Only the asset path. A bare `/install` is the shell installer, which no
    // smoke requests and which this stand-in has no business serving.
    if (url.pathname !== "/install") {
      return new Response("only /install?dl=<asset>&ring=<ring> is served\n", {
        status: 404,
      });
    }

    const asset = url.searchParams.get("dl");
    const ring = url.searchParams.get("ring");
    if (!asset || !ring) {
      return new Response("both dl and ring are required\n", { status: 400 });
    }
    if (!SAFE_SEGMENT.test(asset) || !SAFE_SEGMENT.test(ring)) {
      return new Response("dl and ring must be plain path segments\n", {
        status: 400,
      });
    }

    const target = `${storeOrigin}/cli/${ring}/${asset}`;
    // Logged so the run's own output shows what the smoke resolved, which is
    // the first thing anyone reads when a rehearsal self-update goes wrong.
    console.log(`302 ${url.pathname}${url.search} -> ${target}`);
    return Response.redirect(target, 302);
  },
});

console.log(
  `rehearsal install resolver on http://127.0.0.1:${port}/install -> ${storeOrigin}/cli/<ring>/<asset>`,
);
