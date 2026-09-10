import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ensureOwnerDir } from "./config-dir";

/**
 * Local token storage. Written `0600` (owner read/write only) in a `0700`
 * directory so tokens aren't world-readable (security acceptance bar). Tokens
 * are never logged.
 */

/** Persisted credentials. The type is inferred from the schema so the on-disk
 *  shape and the TypeScript type can't drift. */
const StoredCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  /** Epoch ms when the access token expires (if the AS reported `expires_in`). */
  expiresAt: z.number().optional(),
  /** The user's market (POS), decoded from the id_token at login/refresh; used
   *  to default `--site`. Absent when the id_token carried no country_code. */
  market: z.string().optional(),
  /** Replayed to the API as the `x-wego-id-token` assertion. */
  idToken: z.string().optional(),
});

export type StoredCredentials = z.infer<typeof StoredCredentialsSchema>;

export async function saveCredentials(
  path: string,
  creds: StoredCredentials,
): Promise<void> {
  // Shared with the update-notice throttle, which writes into the same
  // `~/.config/<scope>/` dir and could otherwise create it first at a looser
  // mode — see `config-dir.ts`.
  await ensureOwnerDir(dirname(path));
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // `mode` on mkdir/writeFile only applies on *creation*. The token file is
  // always ours, so keep it 0600 even if it pre-existed with looser perms.
  await chmod(path, 0o600);
}

export async function loadCredentials(
  path: string,
): Promise<StoredCredentials | null> {
  try {
    const result = StoredCredentialsSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function clearCredentials(path: string): Promise<void> {
  await rm(path, { force: true });
}
