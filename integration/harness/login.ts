/**
 * Play the browser's part in `wego login`: read the authorize URL the binary
 * prints, "approve" it, and deliver the callback to the binary's loopback listener.
 */

import type { Fake, TokenSet } from "./fake";
import type { CliResult, Home } from "./wego";
import { spawnWego } from "./wego";

export interface LoginRun {
  result: CliResult;
  /** The authorize URL's query, as the binary built it. */
  authorize: URLSearchParams;
}

export async function loginThroughBrowser(
  fake: Fake,
  home: Home,
  opts: {
    tokens: TokenSet;
    /** Override what the "browser" sends back, to test a refusal. */
    callback?: (redirectUri: string, state: string) => string;
    /** A callback delivered before the real one, e.g. a forged state, or one
     *  that claims another host. */
    before?: (
      redirectUri: string,
      state: string,
    ) => string | { url: string; headers: Record<string, string> };
    /** Login's arguments: `--no-browser` unless a scenario says otherwise. */
    args?: string[];
    env?: Record<string, string>;
  },
): Promise<LoginRun> {
  const running = spawnWego(["login", ...(opts.args ?? ["--no-browser"])], {
    fake,
    home,
    env: opts.env,
  });
  const escaped = fake.authorizeUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let authorize: URLSearchParams;
  try {
    const [printed] = await running.waitForErr(new RegExp(`${escaped}\\?\\S+`));
    authorize = new URL(printed).searchParams;
  } catch (err) {
    // Otherwise the binary keeps its loopback port and outlives the
    // scenario's home directory.
    running.kill();
    throw err;
  }
  const redirectUri = authorize.get("redirect_uri") ?? "";
  const state = authorize.get("state") ?? "";
  fake.armCode({
    code: "code-1",
    codeChallenge: authorize.get("code_challenge") ?? "",
    redirectUri,
    tokens: opts.tokens,
  });
  if (opts.before) {
    const early = opts.before(redirectUri, state);
    const { url, headers } =
      typeof early === "string" ? { url: early, headers: {} } : early;
    await fetch(url, { headers }).catch(() => undefined);
  }
  const target =
    opts.callback?.(redirectUri, state) ??
    `${redirectUri}?code=code-1&state=${encodeURIComponent(state)}`;
  await fetch(target).catch(() => undefined);
  return { result: await running.result, authorize };
}
