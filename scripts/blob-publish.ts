/**
 * The immutable publish step shared by the two Blob publishers,
 * `upload-release-blob.ts` (next/stable) and `publish-edge-blob.ts` (edge).
 *
 * Both write `dist/*` to a per-version prefix that is never overwritten, then
 * advance their own moving pointer by server-side copy. The pointer policy
 * (which prefix, which versions may land on it) differs and stays in each
 * publisher; this step is identical, so it lives here.
 *
 * Dependency-injected (`put` / `openFile` / `log`) so the loop unit-tests without
 * network, a real Blob store, or a `dist/` on disk.
 */
import { list, put } from "@vercel/blob";

export interface ImmutableUploadDeps {
  put: typeof put;
  /** `Bun.file` in production. */
  openFile: (path: string) => Blob;
  log: (message: string) => void;
}

/**
 * Whether a `put` rejection means "this blob is already published".
 *
 * Immutable-conflict signatures differ across `@vercel/blob` versions: the SDK
 * may report an already-published blob as "already exists" or as a
 * precondition/ETag failure (`allowOverwrite: false`). An idempotent resume
 * treats any of them as success; anything else is re-thrown by the caller.
 */
export function isAlreadyPublished(err: unknown): boolean {
  return (
    err instanceof Error &&
    /already exists|precondition|etag/i.test(err.message)
  );
}

/**
 * Publish `names` from `distDir` to `<prefix>/<name>`, skipping anything already
 * in `present`, and return the store origin (the caller's `storeOrigin` when it
 * already knows one, else the origin discovered from the first upload).
 *
 * Every object is written immutable (`allowOverwrite: false`, no random suffix,
 * a one-year cache) because a published version must never be swapped, and
 * `multipart` because the binaries are 60-95 MB and must be chunked rather than
 * buffered whole. A rejection that {@link isAlreadyPublished} recognizes is a
 * resume, not a failure: `list()` lags a just-written blob, so `present` alone
 * cannot decide it.
 */
export async function putImmutableAssets(args: {
  names: readonly string[];
  distDir: string;
  prefix: string;
  present: ReadonlySet<string>;
  token: string;
  storeOrigin?: string;
  deps?: Partial<ImmutableUploadDeps>;
}): Promise<string> {
  const { names, distDir, prefix, present, token } = args;
  const putBlob = args.deps?.put ?? put;
  const openFile = args.deps?.openFile ?? ((path: string) => Bun.file(path));
  const log = args.deps?.log ?? ((message: string) => console.log(message));

  let storeOrigin = args.storeOrigin ?? "";
  for (const name of names) {
    const pathname = `${prefix}/${name}`;
    if (present.has(pathname)) {
      log(`= ${pathname} (already published)`);
      continue;
    }
    try {
      const { url } = await putBlob(pathname, openFile(`${distDir}/${name}`), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: false,
        multipart: true,
        cacheControlMaxAge: 31_536_000,
        token,
      });
      log(`↑ ${url}`);
      if (!storeOrigin) storeOrigin = new URL(url).origin;
    } catch (err) {
      if (!isAlreadyPublished(err)) throw err;
      log(`= ${pathname} (already published)`);
    }
  }
  return storeOrigin;
}

/**
 * The store origin for `prefix`, recovering it by re-listing when the publish
 * phase could not learn one.
 *
 * {@link putImmutableAssets} learns the origin from its first upload, so it
 * returns `""` when it uploads nothing new: every `put` rejected as
 * already-published while the caller's `list()` had not yet shown those blobs
 * (read-after-write lag on a resumed run). An empty origin makes the manifest
 * URL the consistency barrier reads relative, which fails with retries that
 * blame the wrong cause. Re-listing after the uploads recovers it, and a
 * still-empty result is reported as such.
 */
export async function resolveStoreOrigin(args: {
  storeOrigin: string;
  prefix: string;
  token: string;
  deps?: { list?: typeof list };
}): Promise<string> {
  if (args.storeOrigin) return args.storeOrigin;
  const listBlobs = args.deps?.list ?? list;
  const settled = await listBlobs({
    prefix: `${args.prefix}/`,
    token: args.token,
  });
  const first = settled.blobs[0];
  return first ? new URL(first.url).origin : "";
}
