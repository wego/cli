/**
 * The immutable publish half shared by the two Blob publishers -
 * `upload-release-blob.ts` (the flavor channels) and `publish-edge-blob.ts` (the
 * edge ring, foundations#74 rung 5).
 *
 * Both write `dist/*` to a per-version prefix that is never overwritten, then
 * advance their own moving pointer by server-side copy. The pointer POLICY
 * differs (which prefix, which versions may land on it) and stays in each
 * publisher; this phase does not differ at all, so it lives once. Extracted when
 * SonarQube flagged the second copy as duplicated new code.
 *
 * Dependency-injected (`put` / `openFile` / `log`) so the loop unit-tests without
 * network, a real Blob store, or a `dist/` on disk.
 */
import { list, put } from "@vercel/blob";

/** `deps` for {@link putImmutableAssets} - injected so tests supply fakes. */
export interface ImmutableUploadDeps {
  /** `@vercel/blob`'s `put`, injectable for tests. */
  put: typeof put;
  /** Open a local path as the upload body (`Bun.file` in production). */
  openFile: (path: string) => Blob;
  /** Progress line. */
  log: (message: string) => void;
}

/**
 * Whether a `put` rejection means "this blob is already published".
 *
 * Immutable-conflict signatures differ across `@vercel/blob` versions: the SDK
 * may surface an already-published blob as "already exists" OR as a
 * precondition/ETag failure (`allowOverwrite: false`). Any of them means the
 * object is already there, which an idempotent resume must treat as success;
 * anything else is a real fault and is re-thrown by the caller.
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
 * resume, not a failure - `list()` lags a just-written blob, so `present` alone
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
 * {@link putImmutableAssets} discovers the origin from the first upload it
 * performs, so it returns `""` on the one path where it uploads nothing new:
 * every `put` rejected as already-published while the caller's `list()` had not
 * yet surfaced those blobs (read-after-write lag on a resumed run). The origin is
 * then interpolated into the manifest URL the consistency barrier reads, and an
 * empty one silently makes that URL relative - which fails, but as five rounds of
 * "read-after-write lag?" retries naming the wrong cause. Re-listing after the
 * uploads settles it, and a still-empty result is reported as what it is.
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
