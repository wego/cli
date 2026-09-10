import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Create an owner-only config directory, tightening it only when THIS call created
 * it — never chmod a caller-provided existing parent (e.g. `/tmp` or a repo
 * checkout), which would lock other users out of a shared directory.
 *
 * Extracted because more than one thing now writes under `~/.config/<scope>/`:
 * credentials (`storage.ts`) and the update-notice throttle
 * (`index.ts`'s `buildVersionNoticeDeps`). `mode` on `mkdir` applies on *creation*
 * only, so whichever of them runs FIRST on a fresh machine decides the directory's
 * permissions — and the later `login` sees an existing dir and correctly does not
 * re-chmod it. With the rule in one place, "tokens live 0600 in a 0700 directory"
 * cannot be quietly downgraded to 0755 by whichever command a user happened to run
 * first.
 */
export async function ensureOwnerDir(dir: string): Promise<void> {
  // mkdir(recursive) returns the first directory it created, or undefined if the
  // directory already existed.
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) await chmod(dir, 0o700);
}

/** Owner-only JSON write, staged so a killed run leaves no half-written file. */
export async function writeOwnerJson(
  path: string,
  value: unknown,
): Promise<void> {
  await ensureOwnerDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    // Never leave the staging file behind for a failure the caller will report.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
