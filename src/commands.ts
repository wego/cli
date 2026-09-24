import {
  ApiUnreachableError,
  type BookingLinkParams,
  type CreateFlightSearchBody,
  type createFlightSearch,
  type createHotelSearch,
  type FeedbackBody,
  type FlightResultsQuery,
  type fetchBookingLink,
  type fetchFareOptions,
  type fetchFlightResults,
  type fetchFlightTrip,
  type fetchHolidays,
  type fetchHotelBookingLink,
  type fetchHotelDetails,
  type fetchHotelRates,
  type fetchHotelResults,
  type fetchHotelReviews,
  type fetchHotelSearchLink,
  type fetchNearbyPlaces,
  type fetchPlaces,
  type fetchSchedules,
  type fetchSearchLink,
  type fetchTripExperience,
  type fetchVisaFree,
  type fetchWhoami,
  type HolidaysQuery,
  type HotelResultsQuery,
  type HotelsSearchBody,
  type NearbyPlacesQuery,
  NotFoundError,
  type PlacesQuery,
  type PricedOccupancy,
  refreshIdentityAssertion,
  type SchedulesQuery,
  type SearchLinkParams,
  type sendFeedback,
  UnauthorizedError,
  type VisaFreeQuery,
  type WireQueryValues,
} from "./api";
import type { FlightCabin, WireQuery } from "./api-wire";
import { type AuthFailureRecord, buildAuthFailureRecord } from "./auth-failure";
import {
  assertLoopback,
  assertSecureUrl,
  type CliConfig,
  requireClientId,
} from "./config";
import { EXIT, exitCodeForError, formatCliError } from "./error-report";
import type { LoopbackListener } from "./loopback";
import {
  buildAuthorizeUrl,
  type exchangeCode,
  isExpired,
  isIdTokenUsable,
  type refreshTokens,
  type TokenSet,
} from "./oauth";
import type { PastedCallbackWaiter } from "./paste-callback";
import { codeChallengeS256, generateCodeVerifier, generateState } from "./pkce";
import { programName } from "./program-name";
import {
  DEFAULT_SETTLE_BUDGET,
  type Engine,
  runResults,
  runSearch,
  type TerminalState,
} from "./search-engine";
import { applyPreferences, type UserSettings } from "./settings";
import type {
  clearCredentials,
  loadCredentials,
  StoredCredentials,
  saveCredentials,
} from "./storage";
import {
  isProdTarget,
  TARGET_ENV_VAR,
  TARGET_FLAG,
  type Target,
  type TargetSource,
} from "./target";
import { type FlagLine, group, usage } from "./usage";
import { FLIGHTS, HOTELS } from "./verticals";

/**
 * The three commands, written against injectable dependencies so the flows are
 * unit-testable without a browser, a live AS, or the network. `index.ts` wires
 * the real implementations.
 */

/**
 * The command the user actually invoked — `wego` (prod), `wegostaging`
 * (staging), or a renamed binary — resolved once at module load (`process.execPath`
 * is stable for the process). Every user-facing command reference below (the
 * `*_USAGE` constants and the `re-run: … <cmd>` / `run \`<cmd> …\`` hints) is
 * built from this, so a `wegostaging` binary tells the user to run
 * `wegostaging …` instead of a hardcoded `wego …`. Comments/JSDoc keep the
 * literal `wego` — they document the concept, not what to type.
 */
const PROG = programName();

export interface CommandIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

/** True when `args`' first token is a help request — bare `help`, `-h`, or
 *  `--help` (issue #1119). This is the SAME set the `flights`/`hotels` group
 *  dispatchers match on their sub-command slot, so the leaf commands (which call
 *  this against their own arg list, before parsing flags) can't drift from the
 *  group level: `wego flights search help` behaves exactly like `wego flights
 *  search --help`. Each usage short-circuits to that level's usage on stdout with
 *  exit 0 — instead of falling into the parser's "unknown option"/"unknown
 *  sub-command" error path (stderr, exit 1). Only the FIRST token is checked: a
 *  `--help` appearing later (e.g. as a flag's value) is left to the normal parser. */
export function isHelpArg(args: string[]): boolean {
  return args[0] === "help" || args[0] === "-h" || args[0] === "--help";
}

export interface LoginDeps extends CommandIo {
  startLoopback: (redirectPath: string, port: number) => LoopbackListener;
  openBrowser: (url: string) => void;
  exchangeCode: typeof exchangeCode;
  saveCredentials: typeof saveCredentials;
  /** Read a pasted callback URL from the terminal (the SSH path). Omitted in
   *  tests that only exercise the loopback. */
  waitForPastedCallback?: (state: string) => PastedCallbackWaiter;
  /** True inside an SSH session — the browser is on another machine. */
  isRemoteShell?: () => boolean;
}

/**
 * Decide whether to launch a browser on this machine, or a usage message.
 *
 * SSH detection answers "am I in an SSH session", not "is the user's browser
 * elsewhere" — so both directions get an override: `--no-browser` for a remote
 * shell the markers miss (`docker exec`, `sudo -i`, a reattached tmux), and
 * `--browser` for an SSH session that *can* reach a browser here (X11
 * forwarding).
 */
export function parseLoginArgs(
  args: string[],
  isRemote: boolean,
): { skipBrowser: boolean } | { usage: string } {
  const unknown = args.find((a) => a !== "--browser" && a !== "--no-browser");
  if (unknown) return { usage: `Unknown option: ${unknown}\n${LOGIN_USAGE}` };
  const wants = args.includes("--browser");
  const skips = args.includes("--no-browser");
  if (wants && skips) {
    return {
      usage: `Choose --browser or --no-browser, not both.\n${LOGIN_USAGE}`,
    };
  }
  return { skipBrowser: skips || (isRemote && !wants) };
}

/** Login deadline when someone can paste: long enough for the SSH round-trip
 *  (open the URL on the laptop, approve, copy the address bar back into the
 *  terminal). A non-TTY caller keeps the loopback's own shorter default — no
 *  one is there to paste, so waiting longer only delays the failure. */
const PASTE_TIMEOUT_MS = 600_000;

/** What to print before the wait, for each (browser, paste-reader) case. */
function loginInstructions(opts: {
  authorizeUrl: string;
  redirectUri: string;
  skipBrowser: boolean;
  canPaste: boolean;
}): string {
  const { authorizeUrl, redirectUri, skipBrowser, canPaste } = opts;
  if (!skipBrowser) {
    const pasteLine = canPaste
      ? "If the browser is on another computer, paste the redirect URL here instead.\n"
      : "";
    return `Opening your browser to log in. If it doesn't open, visit:\n${authorizeUrl}\n${pasteLine}`;
  }
  return [
    "No browser on this machine. Open this URL on your computer:",
    `\n${authorizeUrl}\n`,
    `After you approve, the browser goes to a ${redirectUri} address that only exists here, so it fails to load. That is expected.`,
    canPaste
      ? "Copy that whole URL from the address bar, paste it below, and press Enter:"
      : "This terminal cannot read a paste, so the login needs that address to reach this machine – forward the port (ssh -L) or re-run from an interactive terminal.",
  ].join("\n");
}

export async function login(
  config: CliConfig,
  deps: LoginDeps,
  args: string[] = [],
): Promise<number> {
  const parsed = parseLoginArgs(args, deps.isRemoteShell?.() ?? false);
  if ("usage" in parsed) {
    deps.error(parsed.usage);
    return EXIT.USAGE;
  }
  const { skipBrowser } = parsed;
  try {
    requireClientId(config);
  } catch (err) {
    deps.error(errorMessage(err));
    // Missing/blank client_id is a misconfiguration caught before any network
    // call — a usage error in the stable taxonomy, not a generic failure.
    return EXIT.USAGE;
  }
  // Declared outside the try so `finally` can close it, but constructed INSIDE
  // so a bind failure (e.g. a fixed WEGO_CLI_REDIRECT_PORT already in use) is
  // caught and reported as "Login failed", not thrown as an uncaught crash.
  let listener: LoopbackListener | undefined;
  let pasted: PastedCallbackWaiter | undefined;
  try {
    // Validate the loopback settings here (not in loadCliConfig) so a malformed
    // login-only env var surfaces as a clean "Login failed", and never breaks
    // whoami/logout which don't use the loopback.
    assertLoopback(config);
    // The AS endpoints carry the auth code / tokens — never over plaintext.
    assertSecureUrl(config.authorizeUrl, "WEGO_AUTH_AUTHORIZE_URL");
    assertSecureUrl(config.tokenUrl, "WEGO_AUTH_TOKEN_URL");
    listener = deps.startLoopback(config.redirectPath, config.redirectPort);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await codeChallengeS256(codeVerifier);
    const state = generateState();
    const authorizeUrl = buildAuthorizeUrl(config, {
      redirectUri: listener.redirectUri,
      state,
      codeChallenge,
    });

    // Arm the loopback waiter (this is what sets `expectedState` + the settle
    // handler inside startLoopback) BEFORE opening the browser. Otherwise a
    // very fast redirect could hit the callback before we're ready to receive
    // it — the callback would be dropped and login would hang until the full
    // timeout despite succeeding in the browser.
    // The paste path runs alongside the loopback, never instead of it: a
    // forwarded port still completes the login by itself, and whichever
    // arrives first wins.
    pasted = deps.waitForPastedCallback?.(state);
    const canPaste = pasted?.armed ?? false;
    const pendingCode = listener.waitForCode(
      state,
      canPaste ? PASTE_TIMEOUT_MS : undefined,
    );
    // Login prints prose, never JSON, so all of it belongs on stderr — the
    // CLI's stdout contract is JSON-only, and a prompt on stderr still reaches
    // the user when stdout is redirected.
    deps.error(
      loginInstructions({
        authorizeUrl,
        redirectUri: listener.redirectUri,
        skipBrowser,
        canPaste,
      }),
    );
    if (!skipBrowser) deps.openBrowser(authorizeUrl);

    const waiters: Promise<string>[] = [pendingCode];
    if (pasted) waiters.push(pasted.promise);
    // The loser is orphaned, not cancelled: nothing interrupts it, it just
    // stops mattering. `finally` releases what it holds (the listener's socket
    // and deadline, the paste reader's stdin), and the pre-attached catch
    // swallows whatever it settles with, so a late rejection is never
    // unhandled.
    for (const w of waiters) w.catch(() => {});
    const code = await Promise.race(waiters);
    const tokens = await deps.exchangeCode(config, {
      code,
      codeVerifier,
      redirectUri: listener.redirectUri,
    });
    await deps.saveCredentials(
      config.credentialsPath,
      tokenSetToStored(tokens),
    );
    deps.error(`Login successful. Run \`${programName()} whoami\` to verify.`);
    return 0;
  } catch (err) {
    deps.error(`Login failed: ${formatCliError(err, programName())}`);
    // Classify through the shared taxonomy so a network/timeout failure from the
    // token exchange (a TypeError/DOMException out of `exchangeCode`) reports its
    // real class (7) instead of masquerading as a usage error. A setup/handshake
    // failure with no typed class — bad loopback config, insecure AS URL,
    // occupied redirect port, or a rejected exchange (plain `Error`) — is a
    // usage/config problem, so the generic fallback maps to USAGE rather than 1.
    const code = exitCodeForError(err);
    return code === EXIT.ERROR ? EXIT.USAGE : code;
  } finally {
    listener?.close();
    // Detaches the stdin listeners; without it the process stays alive holding
    // an open read after the loopback already won.
    pasted?.cancel();
  }
}

/** The credential + refresh dependencies shared by every authenticated command
 *  (`whoami`, `places`). Each command adds its own API-call dependency. */
export interface AuthedCommandDeps extends CommandIo {
  loadCredentials: typeof loadCredentials;
  saveCredentials: typeof saveCredentials;
  refreshTokens: typeof refreshTokens;
  /** The user's travel preferences (issue #1386), memoized by the caller so the
   *  several reads a single command makes cost one file read. A `SettingsFileError`
   *  propagates: an unusable settings file must stop the command (EXIT.USAGE via
   *  `error-report.ts`) rather than silently reprice the answer. */
  loadSettings: () => Promise<UserSettings>;
  /** Persist the most recent failed token exchange locally (investigation
   *  #1360). Best-effort: the helper below ignores a rejection so a diagnostics
   *  write can never mask the auth error it describes. `index.ts` binds the path. */
  recordAuthFailure: (record: AuthFailureRecord) => Promise<void>;
}

/** Report a refresh failure to the user AND leave a local trace of it. Before
 *  #1367 the CLI did the first and not the second, so a silent logout was
 *  undiagnosable after the fact (investigation #1360, H5). The record write is
 *  best-effort: a failed diagnosis must not change the auth outcome. */
async function reportRefreshFailure(
  deps: AuthedCommandDeps,
  err: unknown,
): Promise<void> {
  const message = `Not authenticated: ${errorMessage(err)}. Run \`${programName()} login\`.`;
  deps.error(message);
  // The whole diagnosis is best-effort — the try wraps BOTH the record build and
  // the write, so neither a synchronous throw in `buildAuthFailureRecord` (it runs
  // as an argument, before any `.catch` could attach) nor a rejected write can
  // escape past the caller's AUTH-exit return and flip the exit code.
  try {
    await deps.recordAuthFailure(
      buildAuthFailureRecord(err, message, new Date()),
    );
  } catch {
    // A failed diagnosis must not change the auth outcome.
  }
}

interface PrevSession {
  refreshToken: string;
  market: string | undefined;
  idToken: string | undefined;
}

/**
 * Reactive-refresh retry: the initial call 401'd with a refresh token in hand.
 * Refresh once (carrying the market forward), persist the rotation, then retry
 * `call`. A refresh failure is a genuine auth failure (EXIT.AUTH); a failure of
 * the RETRIED call is an ordinary API error, classified through the shared
 * taxonomy so a 404/429/503 keeps its typed exit class (a second 401 still maps
 * to AUTH via exitCodeForError).
 */
async function reactiveRefreshRetry<T>(
  config: CliConfig,
  deps: AuthedCommandDeps,
  prev: PrevSession,
  call: (accessToken: string, market: string | undefined) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code: number }> {
  let refreshed: TokenSet;
  try {
    refreshed = await refreshAndStore(config, deps, prev);
  } catch (refreshErr) {
    // Only the refresh itself failing means we are genuinely not authenticated.
    await reportRefreshFailure(deps, refreshErr);
    return { ok: false, code: EXIT.AUTH };
  }
  try {
    return {
      ok: true,
      value: await call(refreshed.accessToken, refreshed.market ?? prev.market),
    };
  } catch (retryErr) {
    // A 401 that survives a *successful* refresh is a rejection, not an expired
    // session — describeApiError explains the likely env mismatch (token issued
    // for a different environment than WEGO_API_URL) instead of a bare "run
    // login", and delegates every other failure to the taxonomy message. The
    // stable exit class comes from exitCodeForError.
    deps.error(describeApiError(retryErr, config.apiBaseUrl));
    return { ok: false, code: exitCodeForError(retryErr) };
  }
}

/**
 * Run `call` with a valid access token, handling the whole credential dance:
 * load stored credentials, proactively refresh a known-expired token, and on a
 * reactive 401 refresh once and retry. Any failure is reported via `deps.error`
 * with the user-facing message and the result is `{ ok: false, code }` carrying
 * the stable taxonomy exit class for the caller to propagate; a success returns
 * the call's value for the caller to print.
 *
 * Shared by `whoami` and `places` so the (security-sensitive) refresh/retry flow
 * lives in exactly one place.
 */
/** How the CLI resolved the site code, for its own output. `setting` is
 *  `settings.json` (issue #1386) and `account` the per-user market derived from
 *  the id_token — two sources only a client can set. */
export type CliSiteSource = "explicit" | "setting" | "account" | "default";

/**
 * Resolve the effective `--site` the CLI sends: an explicit `--site` wins; else
 * the user's stored `site` setting; else the market decoded from the logged-in
 * user's id_token (`account`); else nothing (the API floors to US → `default`).
 * Returns `siteCode: undefined` for the default case so the API — not the CLI —
 * owns the US floor.
 *
 * A stored setting deliberately BEATS the account market: a user whose account
 * says SG must be able to price in the market they actually buy from, which is
 * the whole point of the setting existing (issue #1386).
 */
export function resolveCliSite(
  explicit: string | undefined,
  setting: string | undefined,
  market: string | undefined,
): { siteCode?: string; source: CliSiteSource } {
  if (explicit) return { siteCode: explicit, source: "explicit" };
  if (setting) return { siteCode: setting, source: "setting" };
  if (market) return { siteCode: market, source: "account" };
  return { source: "default" };
}

/** How the CLI resolved the pricing currency, for its own output. THREE rungs,
 *  not the site's four: the id_token carries no currency, so there is no
 *  `account` rung.
 *
 *  It labels the currency the CLI ASKED for — the API echoes that same value as
 *  `metadata.currencyCode`. A results read also carries a TOP-LEVEL
 *  `currencyCode`, which is what the prices actually came back in; the two agree
 *  unless upstream declined to reprice, so a `setting` beside a top-level USD
 *  means the stored currency was asked for and not honoured, never that USD came
 *  from the setting.
 *
 *  Not the same field as the API's `metadata.currencyCodeSource`, which answers
 *  "did the API default this to USD" and can only say `explicit` | `default`.
 *  A stored currency is merged into the request before it is sent, so the API
 *  sees it as `explicit`; only the CLI can name the `setting` rung. This
 *  vocabulary is therefore a superset: `explicit` and `default` mean the same
 *  thing in both, and `setting` refines the API's `explicit`. The API's copy
 *  never reaches CLI output — `stripMetadataSources` drops it at print time, so
 *  this top-level field is the ONE answer a payload carries (#1534). */
export type CliCurrencySource = "explicit" | "setting" | "default";

/**
 * Resolve the effective `--currency` the CLI sends: an explicit `--currency`
 * wins; else the user's stored `currency` setting; else nothing (the API applies
 * its USD default → `default`). Returns `currency: undefined` for the default
 * case so the API — not the CLI — owns the USD floor.
 *
 * Deliberately NOT `applyPreferences`, which merges the setting into the request
 * body and erases which rung it came from (issue #1400). The two search commands
 * resolve currency here instead, exactly as they resolve `site` through
 * {@link resolveCliSite}, so the source is still known when the output is built.
 */
export function resolveCliCurrency(
  explicit: string | undefined,
  setting: string | undefined,
): { currency?: string; source: CliCurrencySource } {
  if (explicit) return { currency: explicit, source: "explicit" };
  if (setting) return { currency: setting, source: "setting" };
  return { source: "default" };
}

/**
 * Drop every request-scoped `*Source` copy from the `metadata` of a payload the
 * CLI is about to print (issue #1534, decision Q2: "strip").
 *
 * The API publishes `currencyCodeSource` / `localeSource` inside `metadata` on
 * the priced reads (contract 0.6.0), and `siteCodeSource` on `info schedules`.
 * Each answers a narrower question — "did the API default this?" — in a
 * request-scoped vocabulary (`explicit` | `default`) the CLI's own labels
 * refine: a stored preference is merged into the request before it is sent, so
 * the API reports it as `explicit`, and only the CLI can say `setting`.
 * Forwarding a copy therefore puts two `*Source` fields with two meanings for
 * one knob in one payload, disagreeing by construction whenever a preference is
 * stored. So CLI output publishes exactly ONE `*Source` per knob, at top level,
 * in the CLI's own vocabulary, and the API's copies in `metadata` are dropped
 * at print time (#1400 established this for `localeSource`; #1534 extends it to
 * the rest).
 *
 * The echoes themselves (`currencyCode`, `locale`, `siteCode`) are KEPT. Only
 * the sources are withheld, and only when the payload actually carries
 * metadata; everything else passes through by reference.
 */
export function stripMetadataSources<T>(payload: T): T {
  const metadata = (payload as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== "object") return payload;
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (!entries.some(([key]) => key.endsWith("Source"))) return payload;
  return {
    ...payload,
    metadata: Object.fromEntries(
      entries.filter(([key]) => !key.endsWith("Source")),
    ),
  };
}

/**
 * What every priced read prints on top of the API's body: the CLI's own
 * `currencyCodeSource`, and no `metadata.*Source` copies.
 *
 * The two `search`es already do this inside their vertical, where the create
 * needs the resolved value anyway (#1529). The other six priced reads have no
 * create to hang it on, so they call this at their emit point instead. The field
 * is emitted UNCONDITIONALLY, exactly as the searches emit it: it labels what the
 * CLI resolved and asked for, so unlike the site pair there is no API echo it
 * could be orphaned from.
 */
export function withCurrencyProvenance<T>(
  payload: T,
  source: CliCurrencySource,
): T & { currencyCodeSource: CliCurrencySource } {
  return { ...stripMetadataSources(payload), currencyCodeSource: source };
}

/**
 * One stderr line telling the user that prices are in the API's default currency
 * and how to set their own — the discovery path for `settings.json`, which no
 * human would otherwise know exists (issue #1386).
 *
 * Deliberately narrow: only after a **successful** search-creating command
 * (`flights search` / `hotels search` — the two places a market and a currency
 * are actually decided), and only while no `currency` is stored. `wego config set
 * currency USD` silences it for good, which also makes the USD choice explicit
 * rather than a default nobody chose. A failing command keeps stderr at the
 * single actionable line the exit taxonomy promises, and the exit code is never
 * touched — same rules as the new-version notice. Returns nothing for that
 * reason: the caller's own exit code is the only one there is.
 */
function noteCurrencyDefault(
  code: number,
  explicitCurrency: string | undefined,
  settings: UserSettings,
  deps: CommandIo,
): void {
  if (code !== EXIT.OK) return;
  if (explicitCurrency !== undefined || settings.currency !== undefined) return;
  deps.error(
    `Prices are in the API default currency (USD). Set yours once with \`${PROG} config set currency SAR\` (any ISO 4217 code).`,
  );
}

/** Refresh at the (secure) token URL and persist the rotated set, returning the
 *  refreshed tokens (`refreshToken`/`market` carried forward from the prior set
 *  when the response omits them). Shared by the proactive + reactive refresh
 *  paths so the refresh/persist dance lives in one place. */
async function refreshAndStore(
  config: CliConfig,
  deps: AuthedCommandDeps,
  prev: PrevSession,
): Promise<TokenSet> {
  assertSecureUrl(config.tokenUrl, "WEGO_AUTH_TOKEN_URL");
  const refreshed = await deps.refreshTokens(config, prev.refreshToken);
  const next: TokenSet = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? prev.refreshToken,
    market: refreshed.market ?? prev.market,
    // Kept when a refresh returns none, but only while the API still accepts it.
    idToken:
      refreshed.idToken ??
      (isIdTokenUsable(prev.idToken) ? prev.idToken : undefined),
  };
  await deps.saveCredentials(config.credentialsPath, tokenSetToStored(next));
  refreshIdentityAssertion(next.idToken);
  return next;
}

/** The access/refresh/market to run a call with. `refreshToken`/`market` may be
 *  absent (never logged in with them / id_token had no country). */
interface ActiveSession {
  accessToken: string;
  refreshToken: string | undefined;
  market: string | undefined;
  idToken: string | undefined;
}

/**
 * Load stored credentials and proactively refresh a known-expired token. On the
 * refresh-failure / not-logged-in paths it prints the friendly message and
 * returns `null`, and `withAccessToken` turns that into the `EXIT.AUTH` (3)
 * class. Kept separate from `withAccessToken` so that function's cognitive
 * complexity stays within the new-code gate.
 */
async function loadActiveSession(
  config: CliConfig,
  deps: AuthedCommandDeps,
): Promise<ActiveSession | null> {
  const creds = await deps.loadCredentials(config.credentialsPath);
  if (!creds) {
    deps.error(`Not logged in. Run \`${programName()} login\` first.`);
    return null;
  }
  const session: ActiveSession = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    // The market decoded from the id_token at login/refresh; used to default
    // `--site`. A refresh refreshes it too (a re-login can change the market).
    market: creds.market,
    idToken: creds.idToken,
  };
  // Proactive refresh of a known-expired token, so a revoked/failed refresh
  // exits via the friendly "run wego login" path rather than crashing the CLI.
  if (isExpired(creds.expiresAt) && session.refreshToken) {
    try {
      const refreshed = await refreshAndStore(config, deps, {
        refreshToken: session.refreshToken,
        market: session.market,
        idToken: session.idToken,
      });
      session.accessToken = refreshed.accessToken;
      session.refreshToken = refreshed.refreshToken ?? session.refreshToken;
      session.market = refreshed.market ?? session.market;
      session.idToken = refreshed.idToken ?? session.idToken;
    } catch (err) {
      await reportRefreshFailure(deps, err);
      return null;
    }
  }
  return session;
}

async function withAccessToken<T>(
  config: CliConfig,
  deps: AuthedCommandDeps,
  call: (accessToken: string, market: string | undefined) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code: number }> {
  // The API receives the access token as a Bearer credential — never plaintext.
  try {
    assertSecureUrl(config.apiBaseUrl, "WEGO_API_URL");
  } catch (err) {
    // A misconfigured/insecure WEGO_API_URL is a usage/config error.
    deps.error(errorMessage(err));
    return { ok: false, code: EXIT.USAGE };
  }
  const session = await loadActiveSession(config, deps);
  // Not logged in, or a proactive-refresh failure — both are auth failures.
  if (!session) return { ok: false, code: EXIT.AUTH };
  const { accessToken, refreshToken, market, idToken } = session;

  try {
    return { ok: true, value: await call(accessToken, market) };
  } catch (err) {
    // Reactive refresh: a 401 with a refresh token in hand gets one retry, with
    // the refresh (auth) and the retried call (typed) classified separately.
    if (err instanceof UnauthorizedError && refreshToken) {
      return reactiveRefreshRetry(
        config,
        deps,
        { refreshToken, market, idToken },
        call,
      );
    }
    // Any other failure: print the actionable message (unreachable-host hint,
    // 401 env-mismatch, or the taxonomy's code/detail/trace_id/next action) and
    // return its stable exit class so the caller can propagate it.
    deps.error(describeApiError(err, config.apiBaseUrl));
    return { ok: false, code: exitCodeForError(err) };
  }
}

/** Build the async-search {@link Engine} context for a vertical handler: its
 *  deps bag (api fns + IO + `sleep`) plus the shared `withAccessToken` dance,
 *  injected so `search-engine.ts` stays a pure base layer. */
function makeEngine<
  D extends AuthedCommandDeps & { sleep: (ms: number) => Promise<void> },
>(config: CliConfig, deps: D): Engine<D> {
  return {
    config,
    deps,
    withAccessToken: (call) => withAccessToken(config, deps, call),
  };
}

export interface WhoamiDeps extends AuthedCommandDeps {
  fetchWhoami: typeof fetchWhoami;
}

export async function whoami(
  config: CliConfig,
  deps: WhoamiDeps,
): Promise<number> {
  const result = await withAccessToken(config, deps, (accessToken) =>
    deps.fetchWhoami(config.apiBaseUrl, accessToken),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

export interface PlacesDeps extends AuthedCommandDeps {
  fetchPlaces: typeof fetchPlaces;
}

export async function places(
  config: CliConfig,
  args: string[],
  deps: PlacesDeps,
): Promise<number> {
  // `wego places --help`/`-h`/`help` prints usage on stdout with exit 0, like the
  // flights/hotels leaves — instead of `--help` falling into the parser's
  // "Unknown option" error path (stderr, exit 2) (CLI-3).
  if (isHelpArg(args)) {
    deps.log(PLACES_USAGE);
    return 0;
  }
  // Parse argv first so a usage error never touches the network or credentials.
  let parsed: PlacesQuery;
  try {
    parsed = parsePlacesArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // Locale ONLY. Place resolution is deliberately market-neutral (the API pins
  // the upstream `site_code` to the wildcard), so a stored `site` must never
  // reach it — that would narrow every lookup to one market.
  const query = applyPreferences(parsed, await deps.loadSettings(), ["locale"]);
  const result = await withAccessToken(config, deps, (accessToken) =>
    deps.fetchPlaces(config.apiBaseUrl, accessToken, query),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

// --- info: the four stateless reference lookups (issue #1326) ----------------

export interface InfoDeps extends AuthedCommandDeps {
  fetchHolidays: typeof fetchHolidays;
  fetchVisaFree: typeof fetchVisaFree;
  fetchSchedules: typeof fetchSchedules;
  fetchNearbyPlaces: typeof fetchNearbyPlaces;
}

/** What `info target` publishes. A record rather than an ad-hoc string, so the
 *  human rendering and the machine rendering cannot disagree about a value. */
export interface TargetReport {
  target: Target;
  /** `flag` | `env` | `default` – what to change to change the answer. */
  source: TargetSource;
  apiUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  credentialsPath: string;
  /** True on any non-prod target: this run sends no usage event at all. Stated
   *  rather than implied, because "no telemetry" is a promise a user is entitled
   *  to see rather than infer. */
  telemetrySuppressed: boolean;
}

export function buildTargetReport(config: CliConfig): TargetReport {
  return {
    target: config.target,
    source: config.targetSource,
    apiUrl: config.apiBaseUrl,
    authorizeUrl: config.authorizeUrl,
    tokenUrl: config.tokenUrl,
    credentialsPath: config.credentialsPath,
    telemetrySuppressed: !isProdTarget(config.target),
  };
}

/** The `source` phrased as the thing the reader would edit. */
function targetOrigin(source: TargetSource): string {
  if (source === "flag") return `from ${TARGET_FLAG}`;
  if (source === "env") return `from ${TARGET_ENV_VAR}`;
  return "default";
}

export function formatTargetReport(report: TargetReport): string {
  const rows: [string, string][] = [
    ["target", `${report.target} (${targetOrigin(report.source)})`],
    ["api", report.apiUrl],
    ["authorize", report.authorizeUrl],
    ["token", report.tokenUrl],
    ["credentials", report.credentialsPath],
    [
      "telemetry",
      report.telemetrySuppressed
        ? "suppressed (non-prod target sends nothing)"
        : "as configured",
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `${label.padEnd(width)}  ${value}`)
    .join("\n");
}

/**
 * `wego info <sub> …` — the four reference lookups that need **no prior search**.
 *
 * That is the whole reason they are one group rather than spread across
 * `places`/`flights`. Every other command group is a chain: each step consumes an
 * id the previous step returned, and those ids expire (measured at five to seven
 * minutes). These four take only what the user already said — a country code, a
 * date, a route, a place — so an agent may call them in any order, before or
 * after a search, and reuse the answer for the rest of the conversation.
 *
 *   holidays <country>            GET /v1/countries/{cc}/holidays
 *     → { results: [{ name, key, startDate, endDate }], metadata: { window, from, to } }
 *       `window` tells you whose dates these are: `explicit` (yours) or
 *       `upcoming` (the API chose, and `from`/`to` say which).
 *   visa-free <passportCountry>   GET /v1/countries/{cc}/visa-free-destinations
 *     → { results: [{ countryCode, name, keyCityCode }], metadata: { coverage } }
 *       ONE complete list — the API walks the upstream's 20-row pages for you.
 *       It is an inspiration list, NOT a visa rule: no visa type, no permitted
 *       stay, and an absent country means absent from Wego's list, never "a visa
 *       is required". `coverage: "truncated"` means even the list is partial.
 *   schedules <from> <to>         GET /v1/flights/schedules
 *     → { results: [{ flightNumber, airlineCode, departureTime, … }], metadata }
 *       A timetable with no prices, so it costs one read instead of a whole
 *       priced search. `metadata.from/to` echo `{requested, resolvedCityCode}`,
 *       because the upstream routes on CITY codes — ask for `LHR` and you get
 *       London's timetable, which is what you wanted but not what you typed.
 *   airports-near <place|lat,lng> GET /v1/places/nearby
 *     → { results: [placeSchema…], metadata: { origin } }
 *       Rows are the same shape `wego places` returns, so a code found here drops
 *       straight into `flights search`. `metadata.origin` echoes the point
 *       measured from, so you can confirm which place a code resolved to.
 *
 * The joins these enable — the reason they are worth shipping as primitives
 * rather than as one composite endpoint:
 *
 *   holidays SG            → spot a Sat–Mon span → flights search over it
 *   visa-free PH ∩ holidays PH → intersect on `countryCode` → a shortlist
 *   places "Heathrow" → LHR → airports-near LON → LGW, LTN, STN → search each
 *
 * Every argument is validated locally before any network call, so a typo costs
 * exit 2 rather than a request.
 */
export async function info(
  config: CliConfig,
  args: string[],
  deps: InfoDeps,
): Promise<number> {
  const sub = args[0];
  // `help`/`-h`/`--help` recognized BEFORE sub-command matching, so usage goes to
  // stdout with exit 0 like a real command — the same rule the `flights` and
  // `hotels` dispatchers follow (issue #1119).
  if (isHelpArg(args)) {
    deps.log(INFO_USAGE);
    return 0;
  }
  const rest = args.slice(1);
  switch (sub) {
    case "holidays":
      return infoHolidays(config, rest, deps);
    case "visa-free":
      return infoVisaFree(config, rest, deps);
    case "schedules":
      return infoSchedules(config, rest, deps);
    case "airports-near":
      return infoAirportsNear(config, rest, deps);
    case "target":
      // Purely local: no token, no network. It belongs in `info` for the same
      // reason the other four do – it takes only what the user already said.
      return infoTarget(config, rest, deps);
    default:
      deps.error(
        sub ? `Unknown info sub-command: ${sub}\n${INFO_USAGE}` : INFO_USAGE,
      );
      return EXIT.USAGE;
  }
}

/** The shared leaf shape: parse argv (never touching the network on a usage
 *  error), call the API as the user, print JSON. Identical for all four, so it
 *  lives here once rather than four times. */
async function runInfoLeaf<T extends { locale?: string }>(
  config: CliConfig,
  args: string[],
  deps: InfoDeps,
  usage: string,
  parse: (args: string[]) => T,
  call: (
    accessToken: string,
    market: string | undefined,
    parsed: T,
    settings: UserSettings,
  ) => Promise<unknown>,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(usage);
    return 0;
  }
  let parsed: T;
  try {
    parsed = parse(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // All four inherit `locale`, and only `locale`: none prices anything, and the
  // one site code in the group (holidays) is the country in the PATH, not the
  // user's market. `schedules` resolves its own `--site` inside `call`.
  const settings = await deps.loadSettings();
  const query = applyPreferences(parsed, settings, ["locale"]);
  const result = await withAccessToken(config, deps, (accessToken, market) =>
    call(accessToken, market, query, settings),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

function infoHolidays(
  config: CliConfig,
  args: string[],
  deps: InfoDeps,
): Promise<number> {
  return runInfoLeaf(
    config,
    args,
    deps,
    HOLIDAYS_USAGE,
    parseHolidaysArgs,
    (token, _market, parsed) =>
      deps.fetchHolidays(config.apiBaseUrl, token, parsed),
  );
}

function infoVisaFree(
  config: CliConfig,
  args: string[],
  deps: InfoDeps,
): Promise<number> {
  return runInfoLeaf(
    config,
    args,
    deps,
    VISA_FREE_USAGE,
    parseVisaFreeArgs,
    (token, _market, parsed) =>
      deps.fetchVisaFree(config.apiBaseUrl, token, parsed),
  );
}

function infoSchedules(
  config: CliConfig,
  args: string[],
  deps: InfoDeps,
): Promise<number> {
  return runInfoLeaf(
    config,
    args,
    deps,
    SCHEDULES_USAGE,
    parseSchedulesArgs,
    async (token, market, parsed, settings) => {
      // Same `--site` resolution every market-sensitive command makes: explicit
      // flag → the stored `site` setting → the account market from the id_token →
      // nothing, and the API floors to US.
      const resolved = resolveCliSite(parsed.siteCode, settings.site, market);
      const res = await deps.fetchSchedules(
        config.apiBaseUrl,
        token,
        resolved.siteCode ? { ...parsed, siteCode: resolved.siteCode } : parsed,
      );
      // Stamp the CLI's OWN four-value answer at TOP LEVEL and strip the API's
      // request-scoped copy from metadata (#1534) — the one rule every knob
      // follows. The API only sees whether a siteCode arrived, so it reports a
      // market the CLI resolved from a stored setting or the account token as
      // `explicit` — which breaks the promise that the output names the
      // deciding layer. Only the CLI knows that layer, the same reason
      // `verticals.ts` stamps its own source. The `metadata.siteCode` echo
      // itself stays.
      return {
        ...stripMetadataSources(res),
        siteCodeSource: resolved.source,
      };
    },
  );
}

function infoAirportsNear(
  config: CliConfig,
  args: string[],
  deps: InfoDeps,
): Promise<number> {
  return runInfoLeaf(
    config,
    args,
    deps,
    AIRPORTS_NEAR_USAGE,
    parseAirportsNearArgs,
    (token, _market, parsed) =>
      deps.fetchNearbyPlaces(config.apiBaseUrl, token, parsed),
  );
}

/**
 * `wego info target [--json]` — the resolved backend axis, on both surfaces the
 * rung owes: readable text, and one JSON object for a machine.
 *
 * No token and no network, so it answers logged out and against an unreachable
 * backend — which is exactly when someone asks it. It is also the only command
 * that reports `credentialsPath`, because "which store am I keyed to" is the
 * question a target swap raises.
 *
 * **stdout is the JSON object on every path**, because `info *` is one of the
 * groups `SKILL.md`'s operating contract promises an agent it may `JSON.parse`
 * unconditionally — a table there would throw for the caller that trusted us.
 * The aligned text is a convenience, so it goes to **stderr**, which is where
 * every other human line in this CLI already goes. `--json` therefore means "the
 * object and nothing else": it suppresses the decoration rather than choosing the
 * format, which is already decided.
 */
function infoTarget(
  config: CliConfig,
  args: string[],
  deps: InfoDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(TARGET_USAGE);
    return Promise.resolve(0);
  }
  const unknown = args.find((arg) => arg !== "--json");
  if (unknown !== undefined) {
    deps.error(`Unknown argument: ${unknown}\n${TARGET_USAGE}`);
    return Promise.resolve(EXIT.USAGE);
  }
  const report = buildTargetReport(config);
  deps.log(JSON.stringify(report, null, 2));
  if (!args.includes("--json")) deps.error(formatTargetReport(report));
  return Promise.resolve(0);
}

// --- feedback ---------------------------------------------------------------

export interface FeedbackDeps extends AuthedCommandDeps {
  sendFeedback: typeof sendFeedback;
  /** CLI version, stamped onto the submission so feedback can be sliced by
   *  release. Injected (index.ts holds the baked `VERSION`). */
  version: string;
}

/**
 * `wego feedback [--rating 1-5] [--category flights|hotels|other] [--message …]`
 * — send feedback about the CLI/API experience to the Wego team. Flag-first (so
 * an agent can call it), enum-validated client-side before any network call.
 * The API records it into a PostHog survey; this prints a short confirmation
 * (not JSON — feedback is a terminal action, not part of a value-threading
 * funnel).
 */
export async function feedback(
  config: CliConfig,
  args: string[],
  deps: FeedbackDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(FEEDBACK_USAGE);
    return 0;
  }
  let body: FeedbackBody;
  try {
    body = parseFeedbackArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  if (deps.version) body.version = deps.version;
  const result = await withAccessToken(config, deps, (accessToken) =>
    deps.sendFeedback(config.apiBaseUrl, accessToken, body),
  );
  if (!result.ok) return result.code;
  deps.log("Thanks – your feedback was sent.");
  return 0;
}

// --- flights: search + trip (issue #988) and fare families + booking handoff
// (issue #1014) ---------------------------------------------------------------

export interface FlightsDeps extends AuthedCommandDeps {
  createFlightSearch: typeof createFlightSearch;
  fetchFlightResults: typeof fetchFlightResults;
  fetchFlightTrip: typeof fetchFlightTrip;
  fetchTripExperience: typeof fetchTripExperience;
  fetchFareOptions: typeof fetchFareOptions;
  fetchBookingLink: typeof fetchBookingLink;
  fetchSearchLink: typeof fetchSearchLink;
  /** Delay between `flights results --wait` re-reads (injected for tests). */
  sleep: (ms: number) => Promise<void>;
}

/**
 * `wego flights <sub> …` — the Book-on-Wego funnel, end to end. Five commands
 * chain into one journey (mirroring roxana's: search → results → fare families →
 * booking); each step harvests one id from the previous step's output and hands
 * it to the next. `share` is the sixth and chains with nothing — it is stateless,
 * so it can be called at any point. The endpoints are `apps/api`'s
 * `/v1/flights/*` (items 12/13, issues #988 / #1014 / #1326).
 *
 *   search <from> <to> <date> [--return]   POST /v1/flights/searches (+ one read)
 *     → { searchId, siteCode, siteCodeSource, settled, results: [{ tripId, stops,
 *       durationMinutes, price: { total, websiteCount, hasWegoFare }, legs }] }
 *       — blocks to settled (#1084): `converged` or `budget_exhausted`, not the empty
 *       first snapshot. `siteCode`/`siteCodeSource` echo the market the API resolved.
 *   results <searchId>                     GET  …/searches/{searchId}/results
 *     → a fresher/deeper ranked page of the SAME lean cards — no `fares[]` on any
 *       row since #1308. A Book-on-Wego fare often arrives on a LATER read, so
 *       this is where you re-poll, and `price.hasWegoFare` is the card-level
 *       witness that tells you which trip to open before you fetch it.
 *   trip <tripId> --search <searchId>      GET  …/trips/{tripId}?searchId=…
 *     → full itinerary + every fare (the ONLY surface carrying them, and their
 *       handoff URLs); pick the kind:"wego" one → its fareId.
 *       `--view detail` asks for the other published projection instead — per
 *       segment, with resolved airport names, airline and provider logos, and
 *       seat/amenity metadata. It is a DIFFERENT shape, not a superset: `legs[]`
 *       where the default has `outbound`/`return`, and a `provider` object where
 *       the default has a flat `providerCode`, so `api.ts` parses the two as a
 *       union. Nothing in the funnel reads from it — a fareId still comes from the
 *       default read.
 *   experience <tripId> [--search <searchId>]
 *                                          GET  …/trips/{tripId}/experience
 *     → { tripId, legs: [{ id, departureAirportCode, arrivalAirportCode,
 *       stopsCount, signals }], metadata }: the
 *       comfort half of a trip, off the funnel — it harvests nothing and feeds
 *       nothing. `overnight`/`longStopover`/`earlyDeparture`/`lateArrival` are
 *       always present; the other three signals are positive-only witnesses whose
 *       ABSENCE means unasserted, never false. No score: Recommended sort ranks
 *       on a price-adjusted one, so any number here would contradict it.
 *       `--search` is a cross-check, not context — the tripId already carries it.
 *   fares <fareId>                         GET  …/fares/{fareId}/options
 *     → roxana's fare-families selection page: fare options ordered by leg then
 *       cheapest-first ({ fareOptionId, name, price, baggage, refundable,
 *       exchangeable, penalties, legId }) → pick one → its fareOptionId.
 *       A MULTI-LEG trip returns one ladder PER LEG in `options[]` (#1254), so
 *       `price.covers:"leg"` means that total pays for one leg and the trip needs
 *       one option per leg; the whole-trip figure is the top-level `price.total`,
 *       never `min(options)`. `legs[]` names each leg. `covers` is a positive
 *       witness: absent means unattributed, not whole-trip. `price.passengers`
 *       splits an option by passenger type — the only per-person figure, since a
 *       results/trip total is whole-party (#1256).           [Book-on-Wego only]
 *   booking-link <fareId> --trip <tripId> --fare-option <id> [--fare-option <id>] …
 *                                          GET  …/fares/{fareId}/booking-link
 *     → { bookingUrl, expires: true }: the wego.com deep link into roxana's
 *       integrated booking/payment funnel with that family pre-selected. It is
 *       bound to the live search and dies with it.             [BoW only]
 *       `--fare-option` is ONCE PER LEG (#1254): one id alone silently prices one leg.
 *   share <from> <to> <fromDate> [--return]  GET  …/flights/search-link
 *     → { searchUrl, expires: false }: a DURABLE wego.com search URL to hand to
 *       someone else. Carries no search-scoped id, so it never expires; whoever
 *       opens it runs the search live, at current prices (#1326 Q5).
 *
 * The id chain (each arrow = one value carried to the next command's argument):
 *   search → searchId → (results) → tripId → trip → fareId → fares →
 *   fareOptionId → booking-link → bookingUrl
 *
 * `booking-link` is still an authenticated `GET …/fares/{fareId}/booking-link`
 * request like the others — but a STATELESS one: the API builds the URL locally
 * (no metasearch upstream, no persisted server state — #986 D2/D3), so the
 * caller must re-supply the route / dates / pax / cabin / site from the ORIGINAL
 * `search` inputs it already holds; only `tripId` / `fareId` / `fareOptionId`
 * come from the funnel responses above. `--from-city` / `--to-city` c-prefix the leg codes in
 * the URL (`cdxb-ccai`) to match a city-based search — roxana's own rule
 * (`departureAirportCode ?? c${departureCityCode}`, FlightSearchLayout.tsx); the
 * default `wego flights search DXB CAI` sends city codes, so it needs them.
 *
 * `fares` and `booking-link` are Book-on-Wego (`kind:"wego"`) only — partner /
 * airline fares carry their own `handoffUrl`, which since #1308 is read from
 * `trip` rather than from a `search`/`results` page.
 * Every arg is parsed and validated before any network call.
 */
export async function flights(
  config: CliConfig,
  args: string[],
  deps: FlightsDeps,
): Promise<number> {
  const sub = args[0];
  // `help`/`-h`/`--help` is recognized BEFORE sub-command matching so it never
  // falls into the `default:` "unknown sub-command" arm (issue #1119): usage
  // goes to stdout with exit 0, like a real command, not an error. Shares the
  // exact help condition with every leaf (`isHelpArg`) so the two can't drift.
  if (isHelpArg(args)) {
    deps.log(FLIGHTS_USAGE);
    return 0;
  }
  const rest = args.slice(1);
  switch (sub) {
    case "search":
      return flightsSearch(config, rest, deps);
    case "results":
      return flightsResults(config, rest, deps);
    case "trip":
      return flightsTrip(config, rest, deps);
    case "experience":
      return flightsExperience(config, rest, deps);
    case "fares":
      return flightsFares(config, rest, deps);
    case "booking-link":
      return flightsBookingLink(config, rest, deps);
    case "share":
      return flightsShare(config, rest, deps);
    default:
      deps.error(
        sub
          ? `Unknown flights sub-command: ${sub}\n${FLIGHTS_USAGE}`
          : FLIGHTS_USAGE,
      );
      return EXIT.USAGE;
  }
}

async function flightsFares(
  config: CliConfig,
  args: string[],
  deps: FlightsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(FARES_USAGE);
    return 0;
  }
  let parsed: { fareId: string; currency?: string; locale?: string };
  try {
    parsed = parseFaresArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // Currency through the resolver, not `applyPreferences`, so the rung survives
  // to the emit point (issue #1400). Locale still merges: it has no rung.
  const settings = await deps.loadSettings();
  const currency = resolveCliCurrency(parsed.currency, settings.currency);
  const query = applyPreferences(parsed, settings, ["locale"]);
  const result = await withAccessToken(config, deps, async (accessToken) => {
    try {
      return await deps.fetchFareOptions(
        config.apiBaseUrl,
        accessToken,
        query.fareId,
        { currency: currency.currency, locale: query.locale },
      );
    } catch (err) {
      // A 404 (from the upstream 410/404, LV1) means the fare's search context
      // expired. Point back at the flight search generally, NOT `wego flights
      // search` — that subcommand does not exist yet (#988), so naming it would
      // hand the user a command the dispatcher rejects.
      if (err instanceof NotFoundError) {
        // Keep the type so the expired fare maps to EXIT.NOT_FOUND (4).
        throw new NotFoundError(
          err.label,
          "That fare was not found or its search has expired. Search for flights again and re-open the trip to get a fresh fare id.",
        );
      }
      throw err;
    }
  });
  if (!result.ok) return result.code;
  return printJson(withCurrencyProvenance(result.value, currency.source), deps);
}

async function flightsBookingLink(
  config: CliConfig,
  args: string[],
  deps: FlightsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(BOOKING_LINK_USAGE);
    return 0;
  }
  let fareId: string;
  let params: BookingLinkParams;
  try {
    ({ fareId, ...params } = parseBookingLinkArgs(args));
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  const settings = await deps.loadSettings();
  // The handoff URL carries the currency (`wego_currency`) and the locale
  // (`ulang`), so a settings-priced funnel must not hand off in USD.
  const withPrefs = applyPreferences(params, settings);
  const result = await withAccessToken(config, deps, (accessToken, market) =>
    deps.fetchBookingLink(config.apiBaseUrl, accessToken, fareId, {
      ...withPrefs,
      siteCode: resolveCliSite(params.siteCode, settings.site, market).siteCode,
    }),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

const SHARE_FLAGS = new Set([
  "--return",
  "--cabin",
  "--adults",
  "--children",
  "--infants",
  "--site",
  "--currency",
  "--locale",
]);
const SHARE_BOOL_FLAGS = new Set(["--from-city", "--to-city"]);

/** `--flag → string-field` map, mirroring the booking-link one. `--site` maps
 *  to `siteCode`, matching `flights search`. */
const SHARE_STR_FLAGS: ReadonlyArray<
  [string, "toDate" | "cabin" | "siteCode" | "currency" | "locale"]
> = [
  ["--return", "toDate"],
  ["--cabin", "cabin"],
  ["--site", "siteCode"],
  ["--currency", "currency"],
  ["--locale", "locale"],
];
/** `--flag → pax-field` with the API's own `[min, max]` (apps/api
 *  flights/schema.ts `linkContextShape` + `createFlightsBodySchema`, which agree),
 *  so an out-of-range count is a usage error before any network call rather than a
 *  400 the caller reads as exit 6. Children and infants legitimately allow 0 - the
 *  API and the URL grammar both accept `0c:0i`.
 *
 *  ONE table for every flights parser (`share`, `search`, `booking-link`). They
 *  each had their own before, which is how `booking-link` ended up with no upper
 *  cap at all and why the `--infants` cap of 8 had to be added twice by hand in
 *  this PR. A cap change now lands on all three or none. */
const FLIGHT_PAX_FLAGS: ReadonlyArray<
  [string, "adults" | "children" | "infants", number, number]
> = [
  ["--adults", "adults", 1, 9],
  ["--children", "children", 0, 8],
  ["--infants", "infants", 0, 8],
];

type FlightPaxTarget = { adults?: number; children?: number; infants?: number };

/** Caps and the `infants <= adults` relationship in one step, so no parser can
 *  take one without the other — `booking-link` had drifted from both. */
function applyFlightPax(
  single: Map<string, string>,
  target: FlightPaxTarget,
): void {
  for (const [flag, key, min, max] of FLIGHT_PAX_FLAGS) {
    const v = single.get(flag);
    if (v !== undefined) target[key] = parseIntArg(v, flag, max, min);
  }
  assertInfantsWithinAdults(target.adults, target.infants);
}

export function parseShareArgs(args: string[]): SearchLinkParams {
  const { positional, single, bools } = tokenizeFlagSets(
    args,
    SHARE_USAGE,
    SHARE_FLAGS,
    EMPTY_SET,
    SHARE_BOOL_FLAGS,
  );
  const [from, to, fromDate, ...extra] = positional;
  if (!from || !to || !fromDate) throw new Error(SHARE_USAGE);
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}\n${SHARE_USAGE}`);
  }
  // Shape-check the dates locally so a non-calendar day (`2026-02-30`) is a usage
  // error (exit 2) like every other malformed input to this command, rather than
  // an API 400 the caller reads as exit 6. Only the SHAPE: whether a date is past
  // or beyond the 365-day horizon depends on the server's clock, so the route
  // stays the authority on those.
  const params: SearchLinkParams = {
    from,
    to,
    fromDate: parseIsoDate(fromDate, "<fromDate>"),
  };
  for (const [flag, key] of SHARE_STR_FLAGS) {
    const v = single.get(flag);
    if (v) params[key] = v;
  }
  if (params.toDate !== undefined) {
    params.toDate = parseIsoDate(params.toDate, "--return");
  }
  if (params.cabin !== undefined && !isFlightCabin(params.cabin)) {
    throw new Error(`--cabin must be one of ${[...CABINS].join(", ")}`);
  }
  applyFlightPax(single, params);
  if (bools.has("--from-city")) params.fromCity = true;
  if (bools.has("--to-city")) params.toCity = true;
  return params;
}

async function flightsShare(
  config: CliConfig,
  args: string[],
  deps: FlightsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(SHARE_USAGE);
    return 0;
  }
  let params: SearchLinkParams;
  try {
    params = parseShareArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  const settings = await deps.loadSettings();
  // The share URL carries `currency`, `locale` and `siteCode` (`api.ts`
  // `applyFlightLinkQuery`), so it inherits exactly like `booking-link`: a link
  // built from a settings-priced funnel must not hand off in USD, and a durable
  // link hands the wrong currency to everyone it is shared with, not just once.
  const withPrefs = applyPreferences(params, settings);
  const result = await withAccessToken(config, deps, (accessToken, market) =>
    deps.fetchSearchLink(config.apiBaseUrl, accessToken, {
      ...withPrefs,
      siteCode: resolveCliSite(params.siteCode, settings.site, market).siteCode,
    }),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

const FARES_FLAGS = new Set(["--currency", "--locale"]);

export function parseFaresArgs(args: string[]): {
  fareId: string;
  currency?: string;
  locale?: string;
} {
  const { positional, single } = tokenizeFlagSets(
    args,
    FARES_USAGE,
    FARES_FLAGS,
  );
  const fareId = positional[0];
  if (!fareId) throw new Error(FARES_USAGE);
  if (positional.length > 1) {
    throw new Error(`Unexpected argument: ${positional[1]}\n${FARES_USAGE}`);
  }
  const result: { fareId: string; currency?: string; locale?: string } = {
    fareId,
  };
  const currency = single.get("--currency");
  const locale = single.get("--locale");
  if (currency) result.currency = currency;
  if (locale) result.locale = locale;
  return result;
}

const BOOKING_LINK_FLAGS = new Set([
  "--trip",
  "--search",
  "--from",
  "--to",
  "--date",
  "--return",
  "--cabin",
  "--adults",
  "--children",
  "--infants",
  "--site",
  "--currency",
  "--locale",
]);
const BOOKING_LINK_LIST_FLAGS = new Set(["--fare-option"]);
const BOOKING_LINK_BOOL_FLAGS = new Set(["--from-city", "--to-city"]);

/** `--flag → string-field` mappings for the optional booking-link args.
 *  (`--fare-option` is required, not optional — handled separately below.) */
const BOOKING_LINK_STR_FLAGS: ReadonlyArray<
  [string, "searchId" | "toDate" | "cabin" | "siteCode" | "currency" | "locale"]
> = [
  ["--search", "searchId"],
  ["--return", "toDate"],
  ["--cabin", "cabin"],
  ["--site", "siteCode"],
  ["--currency", "currency"],
  ["--locale", "locale"],
];

function requiredFlag(flags: Map<string, string>, name: string): string {
  const v = flags.get(name);
  if (!v) throw new Error(`${name} is required\n${BOOKING_LINK_USAGE}`);
  return v;
}

/** Raw `--fare-option` values, before the shared tokenizer drops blank parts. */
function rawFlagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  const eq = `${name}=`;
  // No index skip after a match: `readFlagValue` refuses a `--`-prefixed value,
  // so a flag's value can never be `name` itself.
  args.forEach((arg, i) => {
    if (arg === name) {
      const value = args[i + 1];
      if (value !== undefined) out.push(value);
    } else if (arg.startsWith(eq)) {
      out.push(arg.slice(eq.length));
    }
  });
  return out;
}

// `splitCsv` silently drops empty parts, so `a,,b` would under-send as `a,b`.
function assertNoBlankFareOption(args: string[], name: string): void {
  for (const raw of rawFlagValues(args, name)) {
    if (raw.split(",").some((part) => part.trim() === "")) {
      throw new Error(
        `${name} has a blank fare option id\n${BOOKING_LINK_USAGE}`,
      );
    }
  }
}

function requiredFareOptions(
  lists: Map<string, string[]>,
  name: string,
): string {
  const ids = lists.get(name);
  if (!ids || ids.length === 0) {
    throw new Error(`${name} is required\n${BOOKING_LINK_USAGE}`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      `${name} must not repeat a fare option id\n${BOOKING_LINK_USAGE}`,
    );
  }
  return ids.join(",");
}

/** parseBookingLinkArgs result: the API params plus the positional `fareId`,
 *  with `fareOptionId` narrowed to required so an optional read fails to compile. */
type ParsedBookingLink = Omit<BookingLinkParams, "fareOptionId"> & {
  fareId: string;
  fareOptionId: string;
};

export function parseBookingLinkArgs(args: string[]): ParsedBookingLink {
  const { positional, single, list, bools } = tokenizeFlagSets(
    args,
    BOOKING_LINK_USAGE,
    BOOKING_LINK_FLAGS,
    BOOKING_LINK_LIST_FLAGS,
    BOOKING_LINK_BOOL_FLAGS,
  );
  const fareId = positional[0];
  if (!fareId) throw new Error(BOOKING_LINK_USAGE);
  if (positional.length > 1) {
    throw new Error(
      `Unexpected argument: ${positional[1]}\n${BOOKING_LINK_USAGE}`,
    );
  }

  assertNoBlankFareOption(args, "--fare-option");
  const params: ParsedBookingLink = {
    fareId,
    tripId: requiredFlag(single, "--trip"),
    fareOptionId: requiredFareOptions(list, "--fare-option"),
    from: requiredFlag(single, "--from"),
    to: requiredFlag(single, "--to"),
    fromDate: parseIsoDate(requiredFlag(single, "--date"), "--date"),
  };
  for (const [flag, key] of BOOKING_LINK_STR_FLAGS) {
    const v = single.get(flag);
    if (v) params[key] = v;
  }
  if (params.toDate !== undefined) {
    params.toDate = parseIsoDate(params.toDate, "--return");
  }
  applyFlightPax(single, params);
  if (bools.has("--from-city")) params.fromCity = true;
  if (bools.has("--to-city")) params.toCity = true;
  return params;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Mirror the API's `page`/`pageSize` caps (apps/api places/schema.ts) so an
 *  out-of-range value fails with a helpful message instead of a raw 400. */
const MAX_PAGE = 100;
const MAX_PAGE_SIZE = 50;

/** Split a comma-separated list-flag value (`--types`, `--airlines`, …) into
 *  trimmed, non-empty parts. */
function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Turn `wego places` argv (everything after the command) into a `PlacesQuery`.
 * Deliberately tiny — the CLI uses plain `process.argv`, no arg-parsing library.
 * `--types` may be repeated and/or comma-separated (a `list` flag). Throws a
 * usage `Error` on a missing/extra query or a malformed flag.
 */
export function parsePlacesArgs(args: string[]): PlacesQuery {
  const { positional, single, list } = tokenizeFlagSets(
    args,
    PLACES_USAGE,
    new Set(["--locale", "--page", "--page-size"]),
    new Set(["--types"]),
  );
  const query = positional[0];
  if (!query) throw new Error(PLACES_USAGE);
  if (positional.length > 1) {
    throw new Error(`Unexpected argument: ${positional[1]}\n${PLACES_USAGE}`);
  }

  const types = list.get("--types") ?? [];
  const locale = single.get("--locale");
  const pageRaw = single.get("--page");
  const pageSizeRaw = single.get("--page-size");

  const result: PlacesQuery = { query };
  if (types.length > 0) result.types = types;
  if (locale) result.locale = locale;
  if (pageRaw !== undefined)
    result.page = parseIntArg(pageRaw, "--page", MAX_PAGE);
  if (pageSizeRaw !== undefined) {
    result.pageSize = parseIntArg(pageSizeRaw, "--page-size", MAX_PAGE_SIZE);
  }
  return result;
}

// --- info parsers (issue #1326) ----------------------------------------------

/** The API's visa-free `pageSize` ceiling, mirrored so an over-large value fails
 *  with a helpful message instead of a raw 400. Bigger than the other commands'
 *  cap because one complete list is the point (AE is 157 rows). */
const MAX_VISA_FREE_PAGE_SIZE = 200;
const MAX_VISA_FREE_PAGE = 20;

/** The API's schedules ceilings, mirrored so an over-large value fails locally. */
const MAX_SCHEDULES_PAGE_SIZE = 200;
const MAX_SCHEDULES_PAGE = 20;

/** The place types `airports-near` may ask for. Mirrors the API's `PLACE_TYPES`
 *  (the apps are self-contained, so this is a mirror, not an import). */
const NEARBY_TYPES = new Set(["airport", "city", "state", "district", "hotel"]);

/** A 2-letter ISO 3166-1 alpha-2 country code, uppercased. Validated locally so a
 *  typo costs exit 2 rather than a request — and because BOTH upstreams behind
 *  these commands answer an unknown country with an empty list, not an error. */
function parseCountryCode(raw: string, label: string, usage: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(
      `${label} must be a 2-letter ISO country code (e.g. SG)\n${usage}`,
    );
  }
  return code;
}

/** A 3-letter city or airport code, uppercased. */
function parsePlaceCode(raw: string, label: string, usage: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(
      `${label} must be a 3-letter city or airport code (e.g. SIN)\n${usage}`,
    );
  }
  return code;
}

/** An ISO `YYYY-MM-DD` date that is also a real calendar day — `2026-02-31`
 *  matches the pattern and is not a date, and the upstream would answer it with
 *  an empty list rather than an error. */
function parseIsoDate(raw: string, flag: string): string {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${flag} must be a date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${flag} must be a real calendar date`);
  }
  return value;
}

/** Exactly one positional, or a usage error naming the extra. */
function onlyPositional(positional: string[], usage: string): string {
  const first = positional[0];
  if (!first) throw new Error(usage);
  if (positional.length > 1) {
    throw new Error(`Unexpected argument: ${positional[1]}\n${usage}`);
  }
  return first;
}

export function parseHolidaysArgs(args: string[]): HolidaysQuery {
  const { positional, single } = tokenizeFlagSets(
    args,
    HOLIDAYS_USAGE,
    new Set(["--from", "--to", "--locale"]),
  );
  const countryCode = parseCountryCode(
    onlyPositional(positional, HOLIDAYS_USAGE),
    "<country>",
    HOLIDAYS_USAGE,
  );

  const fromRaw = single.get("--from");
  const toRaw = single.get("--to");
  // Both or neither. Exactly one is rejected rather than half-guessed: a caller
  // who sent only `--from` meant a range, and inventing its other end would
  // answer a question they did not ask. The API enforces the same rule; checking
  // here means the typo costs no round trip.
  if ((fromRaw === undefined) !== (toRaw === undefined)) {
    throw new Error(
      `Provide both --from and --to, or neither.\n${HOLIDAYS_USAGE}`,
    );
  }

  const query: HolidaysQuery = { countryCode };
  if (fromRaw !== undefined && toRaw !== undefined) {
    query.from = parseIsoDate(fromRaw, "--from");
    query.to = parseIsoDate(toRaw, "--to");
    if (query.from > query.to) {
      throw new Error("--from must not be after --to");
    }
  }
  const locale = single.get("--locale");
  if (locale) query.locale = locale;
  return query;
}

export function parseVisaFreeArgs(args: string[]): VisaFreeQuery {
  const { positional, single } = tokenizeFlagSets(
    args,
    VISA_FREE_USAGE,
    new Set(["--locale", "--page", "--page-size"]),
  );
  const query: VisaFreeQuery = {
    countryCode: parseCountryCode(
      onlyPositional(positional, VISA_FREE_USAGE),
      "<passportCountry>",
      VISA_FREE_USAGE,
    ),
  };
  const locale = single.get("--locale");
  if (locale) query.locale = locale;
  const pageRaw = single.get("--page");
  if (pageRaw !== undefined) {
    query.page = parseIntArg(pageRaw, "--page", MAX_VISA_FREE_PAGE);
  }
  const pageSizeRaw = single.get("--page-size");
  if (pageSizeRaw !== undefined) {
    query.pageSize = parseIntArg(
      pageSizeRaw,
      "--page-size",
      MAX_VISA_FREE_PAGE_SIZE,
    );
  }
  return query;
}

export function parseSchedulesArgs(args: string[]): SchedulesQuery {
  const { positional, single } = tokenizeFlagSets(
    args,
    SCHEDULES_USAGE,
    new Set(["--airline", "--site", "--locale", "--page", "--page-size"]),
  );
  if (positional.length < 2) throw new Error(SCHEDULES_USAGE);
  if (positional.length > 2) {
    throw new Error(
      `Unexpected argument: ${positional[2]}\n${SCHEDULES_USAGE}`,
    );
  }
  const query: SchedulesQuery = {
    from: parsePlaceCode(positional[0], "<from>", SCHEDULES_USAGE),
    to: parsePlaceCode(positional[1], "<to>", SCHEDULES_USAGE),
  };
  const airline = single.get("--airline");
  if (airline !== undefined) {
    const code = airline.trim().toUpperCase();
    if (!/^[A-Z0-9]{2}$/.test(code)) {
      throw new Error("--airline must be a 2-character IATA code (e.g. SQ)");
    }
    query.airline = code;
  }
  const site = single.get("--site");
  if (site !== undefined) {
    const code = site.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new Error("--site must be a 2-letter country code (e.g. SG)");
    }
    // Only shape-checked here; `infoSchedules` resolves it against the account
    // market, since the id_token is not available to a parser.
    query.siteCode = code;
  }
  const locale = single.get("--locale");
  if (locale) query.locale = locale;
  const pageRaw = single.get("--page");
  if (pageRaw !== undefined) {
    query.page = parseIntArg(pageRaw, "--page", MAX_SCHEDULES_PAGE);
  }
  const pageSizeRaw = single.get("--page-size");
  if (pageSizeRaw !== undefined) {
    query.pageSize = parseIntArg(
      pageSizeRaw,
      "--page-size",
      MAX_SCHEDULES_PAGE_SIZE,
    );
  }
  return query;
}

export function parseAirportsNearArgs(args: string[]): NearbyPlacesQuery {
  const { positional, single, list } = tokenizeFlagSets(
    args,
    AIRPORTS_NEAR_USAGE,
    new Set(["--locale", "--page-size"]),
    new Set(["--types"]),
  );
  const location = onlyPositional(positional, AIRPORTS_NEAR_USAGE);

  // Resolved BY SHAPE, the same idiom `hotels search` uses for its positional: a
  // `lat,lng` pair is coordinates, anything else must be a 3-letter code. No flag
  // needed, and no way to send a code where coordinates were meant.
  const query: NearbyPlacesQuery = nearbyLocationFields(location);

  const types = list.get("--types") ?? [];
  if (types.length > 0) {
    query.types = validateEnumList(
      types.map((t) => t.trim().toLowerCase()),
      NEARBY_TYPES,
      "--types",
    );
  }
  const locale = single.get("--locale");
  if (locale) query.locale = locale;
  const pageSizeRaw = single.get("--page-size");
  if (pageSizeRaw !== undefined) {
    query.pageSize = parseIntArg(pageSizeRaw, "--page-size", MAX_PAGE_SIZE);
  }
  return query;
}

/**
 * `lat,lng` → coordinates; otherwise a place code. Mirrors `locationFields` (the
 * hotels positional) minus the hotelId branch, which has no meaning here — and
 * mirrors its **strictness** too: the shape is matched with a regex rather than
 * split-and-`Number`, because `Number("")` is `0`. A split-based check accepts
 * `51.47,` as latitude 51.47 / longitude 0 and sends the user a point in the sea,
 * which the API cannot reject either — 0 is a legal coordinate.
 */
const LAT_LNG = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;

function nearbyLocationFields(location: string): NearbyPlacesQuery {
  const trimmed = location.trim();
  if (trimmed.includes(",")) {
    const geo = LAT_LNG.exec(trimmed);
    if (!geo) {
      throw new Error(
        `Invalid location "${location}": use a 3-letter place code or lat,lng (both numbers)`,
      );
    }
    const latitude = Number(geo[1]);
    const longitude = Number(geo[2]);
    if (latitude < -90 || latitude > 90) {
      throw new Error("latitude must be between -90 and 90");
    }
    if (longitude < -180 || longitude > 180) {
      throw new Error("longitude must be between -180 and 180");
    }
    return { latitude, longitude };
  }
  return {
    place: parsePlaceCode(trimmed, "<place>", AIRPORTS_NEAR_USAGE),
  };
}

/** The categories the feedback survey accepts. Mirrors the API's
 *  `feedbackCategorySchema` (apps are self-contained; the CLI mirrors, not
 *  imports). */
const FEEDBACK_CATEGORIES = new Set(["flights", "hotels", "other"]);

/** Match the API's `message` length cap so an over-long message fails with a
 *  helpful usage error instead of a raw 400. */
const MAX_FEEDBACK_MESSAGE = 2000;

/**
 * Turn `wego feedback` argv into a `FeedbackBody`. Flag-only (no positionals);
 * enum-validates `--rating` (1-5) and `--category` before any network call, and
 * requires at least one of `--rating`/`--message` (a bare `--category` carries
 * no feedback — same rule the API enforces). Throws a usage `Error` on any
 * malformed/extra input.
 */
export function parseFeedbackArgs(args: string[]): FeedbackBody {
  const { positional, single } = tokenizeFlagSets(
    args,
    FEEDBACK_USAGE,
    new Set(["--rating", "--category", "--message"]),
  );
  if (positional.length > 0) {
    throw new Error(`Unexpected argument: ${positional[0]}\n${FEEDBACK_USAGE}`);
  }
  const body: FeedbackBody = {};
  const ratingRaw = single.get("--rating");
  if (ratingRaw !== undefined) {
    body.rating = parseIntArg(ratingRaw, "--rating", 5);
  }
  const category = single.get("--category");
  if (category !== undefined) {
    if (!FEEDBACK_CATEGORIES.has(category)) {
      throw new Error(
        `--category must be one of ${[...FEEDBACK_CATEGORIES].join(", ")}`,
      );
    }
    body.category = category as FeedbackBody["category"];
  }
  const message = single.get("--message");
  if (message !== undefined) {
    const trimmed = message.trim();
    if (trimmed.length === 0) throw new Error("--message must not be empty");
    if (trimmed.length > MAX_FEEDBACK_MESSAGE) {
      throw new Error(
        `--message must be at most ${MAX_FEEDBACK_MESSAGE} characters`,
      );
    }
    body.message = trimmed;
  }
  if (body.rating === undefined && body.message === undefined) {
    throw new Error(`Provide --rating or --message.\n${FEEDBACK_USAGE}`);
  }
  return body;
}

/** Parse a strictly-decimal integer CLI arg in `[min, max]`. Rejects non-decimal
 *  forms (`0x10`, `1e3`, padded/whitespace) that `Number()` would silently
 *  coerce. `min` defaults to 1 (positive); pass `min: 0` for counts that
 *  legitimately allow zero (e.g. `--children`/`--infants`, which the API accepts
 *  as `0c:0i`). `max` is an optional inclusive upper bound. The single
 *  whole-number parser for every CLI command (flights counts/pages included —
 *  the former `parseCount` was merged in, CLI-2). */
/** The API's `infants <= adults` tightening, applied locally so it stays a usage
 *  error (exit 2) instead of a 400 read as exit 6. The defaults mirror the
 *  schema's, since an omitted flag is still a resolved count upstream. */
function assertInfantsWithinAdults(adults = 1, infants = 0): void {
  if (infants > adults) {
    throw new Error("--infants must not exceed --adults");
  }
}

/** Parse a bounded DECIMAL flag value (`--min-guest-rating 8.5`), rejecting the
 *  three shapes a bare `Number()` would let through to a pointless request: a
 *  non-numeric string, a value outside the inclusive range, and the non-finite
 *  literals (`Infinity`, `NaN`) that `Number()` happily produces. Integer flags
 *  keep `parseIntArg`; this exists because a rating is genuinely fractional. */
function parseRangedFloatArg(
  raw: string,
  name: string,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return n;
}

function parseIntArg(raw: string, name: string, max?: number, min = 1): number {
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new Error(
      min === 0
        ? `${name} must be a non-negative integer`
        : `${name} must be a positive integer`,
    );
  }
  const n = Number(raw);
  if (max !== undefined && n > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Hotels (issues #1041 + #1042)
// ---------------------------------------------------------------------------

/** Upper bound on `--children` (and thus `--children-ages` length), mirroring
 *  the API's `MAX_CHILDREN`. Capped locally so an over-count fails fast without
 *  a round trip (issue #1114). */
const MAX_CHILDREN = 8;

// `/rates` settle: count stability decides; `done` only confirms an empty page.
const HOTEL_RATES_MAX_READS = 10;
const HOTEL_RATES_SPACING_MS = 1500;
const HOTEL_RATES_STABLE_READS = 4;
const HOTEL_RATES_EMPTY_DONE_READS = 2;

export interface HotelsDeps extends AuthedCommandDeps {
  createHotelSearch: typeof createHotelSearch;
  fetchHotelResults: typeof fetchHotelResults;
  fetchHotelDetails: typeof fetchHotelDetails;
  fetchHotelRates: typeof fetchHotelRates;
  fetchHotelBookingLink: typeof fetchHotelBookingLink;
  fetchHotelSearchLink: typeof fetchHotelSearchLink;
  fetchHotelReviews: typeof fetchHotelReviews;
  /** Injected so tests drive the settle without real timers. */
  sleep: (ms: number) => Promise<void>;
}

/** Resolve the positional location arg by shape: 3-letter city code, all-digit
 *  hotelId, or a `lat,lng` pair. */
function locationFields(location: string): Partial<HotelsSearchBody> {
  if (/^[A-Z]{3}$/.test(location)) return { cityCode: location };
  if (/^\d+$/.test(location)) return { hotelId: Number(location) };
  const geo = location.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (geo) return { lat: Number(geo[1]), lng: Number(geo[2]) };
  throw new Error(
    `Invalid location "${location}": use a 3-letter city code, a hotelId, or lat,lng`,
  );
}

/** Ints 0-17, at most MAX_CHILDREN; the cap lives here so every caller fails fast locally. */
function parseChildrenAges(raw: string): number[] {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error("--children-ages requires at least one age");
  }
  if (parts.length > MAX_CHILDREN) {
    throw new Error(
      `--children-ages allows at most ${MAX_CHILDREN} ages (got ${parts.length})`,
    );
  }
  return parts.map((p) => {
    if (!/^\d+$/.test(p) || Number(p) > 17) {
      throw new Error(`--children-ages must be integers 0–17 (got "${p}")`);
    }
    return Number(p);
  });
}

/** Apply the shared occupancy/site/currency/locale flags onto a search body. */
function applyOccupancyFlags(
  body: HotelsSearchBody,
  flags: Map<string, string>,
) {
  const adults = flags.get("--adults");
  if (adults) body.adults = parseIntArg(adults, "--adults");
  const children = flags.get("--children");
  // children legitimately allows 0 (the API schema is min-0); pass min=0 so an
  // explicit `--children 0` forwards through instead of erroring as "positive".
  // Cap at MAX_CHILDREN (matching flights' `--children` bound) so an over-count
  // fails fast locally rather than 400-ing upstream (issue #1114).
  if (children !== undefined)
    body.children = parseIntArg(children, "--children", MAX_CHILDREN, 0);
  // `--children-ages` is validated against `--children`: it requires an explicit
  // `--children` and the age count must match, so a family's real ages survive
  // to the API (which then prices each child at that age, not a silent age 8).
  const childrenAges = flags.get("--children-ages");
  if (childrenAges !== undefined) {
    const ages = parseChildrenAges(childrenAges);
    if (body.children === undefined) {
      throw new Error("--children-ages requires --children");
    }
    if (ages.length !== body.children) {
      throw new Error(
        `--children-ages count (${ages.length}) must equal --children (${body.children})`,
      );
    }
    body.childrenAges = ages;
  }
  const rooms = flags.get("--rooms");
  if (rooms) body.rooms = parseIntArg(rooms, "--rooms");
  const site = flags.get("--site");
  if (site) body.siteCode = site;
  const currency = flags.get("--currency");
  if (currency) body.currency = currency;
  const locale = flags.get("--locale");
  if (locale) body.locale = locale;
}

export async function settleRates<
  T extends { searchComplete?: boolean; rates?: unknown[] },
>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<{ snapshot: T; state: TerminalState }> {
  const emptyDone = (snapshot: T) =>
    (snapshot.rates?.length ?? 0) === 0 && snapshot.searchComplete === true;
  let snapshot = await read();
  let reads = 1;
  let stableReads = 1;
  let emptyDoneReads = emptyDone(snapshot) ? 1 : 0;
  for (;;) {
    const count = snapshot.rates?.length ?? 0;
    const converged =
      count > 0
        ? stableReads >= HOTEL_RATES_STABLE_READS
        : emptyDoneReads >= HOTEL_RATES_EMPTY_DONE_READS;
    if (converged) {
      return { snapshot, state: "converged" };
    }
    if (reads >= HOTEL_RATES_MAX_READS) {
      return { snapshot, state: "budget_exhausted" };
    }
    await sleep(HOTEL_RATES_SPACING_MS);
    snapshot = await read();
    reads += 1;
    stableReads = (snapshot.rates?.length ?? 0) === count ? stableReads + 1 : 1;
    emptyDoneReads = emptyDone(snapshot) ? emptyDoneReads + 1 : 0;
  }
}

const SEARCH_FLAGS = new Set([
  "--adults",
  "--children",
  "--children-ages",
  "--rooms",
  "--radius",
  "--site",
  "--currency",
  "--locale",
]);

function parseSearchArgs(args: string[]): HotelsSearchBody {
  const { positional, single } = tokenizeFlagSets(
    args,
    HOTELS_SEARCH_USAGE,
    SEARCH_FLAGS,
  );
  const [location, checkIn, checkOut, ...extra] = positional;
  if (!location || !checkIn || !checkOut) {
    throw new Error(HOTELS_SEARCH_USAGE);
  }
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}\n${HOTELS_SEARCH_USAGE}`);
  }
  const body: HotelsSearchBody = {
    ...locationFields(location),
    checkIn,
    checkOut,
  };
  const radius = single.get("--radius");
  if (radius) body.radius = parseIntArg(radius, "--radius");
  applyOccupancyFlags(body, single);
  return body;
}

async function hotelsSearch(
  config: CliConfig,
  args: string[],
  deps: HotelsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(HOTELS_SEARCH_USAGE);
    return 0;
  }
  let body: HotelsSearchBody;
  try {
    body = parseSearchArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // ①+③ through the shared engine: create, block-to-settled on candidate-count
  // convergence, stamp `settled` (issue #1084). The `HOTELS` vertical owns the
  // per-vertical pieces (site resolution, the occupancy echo, the empty-page
  // note); the create + settle-read run in SEPARATE authed calls (inside
  // `runSearch`) so a mid-settle 401 never re-POSTs a second search.
  // Only `locale` is merged here. `currency` and `site` are resolved INSIDE the
  // vertical, which owns both source stamps: merging a stored currency into the
  // body first is what erased its rung before issue #1400. The vertical still
  // derives the post-create read from the value it resolved, so the read cannot
  // come back in a different unit than the search was priced in.
  const settings = await deps.loadSettings();
  const code = await runSearch(
    HOTELS,
    applyPreferences(body, settings, ["locale"]),
    DEFAULT_SETTLE_BUDGET,
    makeEngine(config, deps),
  );
  noteCurrencyDefault(code, body.currency, settings, deps);
  return code;
}

const HOTELS_SHARE_FLAGS = new Set([
  "--adults",
  "--children",
  "--children-ages",
  "--rooms",
  "--site",
  "--currency",
  "--locale",
]);

const MAX_SHARE_ROOMS = 4;

/** The route's `rooms <= adults` rule, applied locally so it stays a usage error
 *  (exit 2). The adults default mirrors the schema's, since an omitted flag is
 *  still a resolved count upstream. */
function assertRoomsWithinAdults(adults = 2, rooms = 1): void {
  if (rooms > adults) {
    throw new Error(
      `--rooms must not exceed --adults (${adults}${adults === 2 ? ", the default when --adults is omitted" : ""})`,
    );
  }
}

/** `applyOccupancyFlags`' twin for the share query: string values, and ages required rather than defaulted. */
function applyShareOccupancy(
  query: WireQueryValues<"getHotelSearchLink">,
  flags: Map<string, string>,
): void {
  const adults = flags.get("--adults");
  if (adults) query.adults = String(parseIntArg(adults, "--adults"));
  const rooms = flags.get("--rooms");
  if (rooms) {
    query.rooms = String(parseIntArg(rooms, "--rooms", MAX_SHARE_ROOMS));
    assertRoomsWithinAdults(
      adults === undefined ? undefined : Number(query.adults),
      Number(query.rooms),
    );
  }
  const children = flags.get("--children");
  if (children !== undefined) {
    query.children = String(
      parseIntArg(children, "--children", MAX_CHILDREN, 0),
    );
  }
  const childrenAges = flags.get("--children-ages");
  if (childrenAges === undefined) {
    if (children !== undefined && Number(children) > 0) {
      throw new Error(
        "--children-ages is required with --children above 0: a durable link must not show a guessed age",
      );
    }
    return;
  }
  if (children === undefined) {
    throw new Error("--children-ages requires --children");
  }
  const ages = parseChildrenAges(childrenAges);
  if (ages.length !== Number(children)) {
    throw new Error(
      `--children-ages has ${ages.length} age(s) but --children is ${children}`,
    );
  }
  query.childrenAges = ages.join(",");
}

/** Parse `hotels share`: city only, since wego.com serves no other shareable hotel-search URL. */
export function parseHotelsShareArgs(
  args: string[],
): WireQueryValues<"getHotelSearchLink"> {
  const { positional, single } = tokenizeFlagSets(
    args,
    HOTELS_SHARE_USAGE,
    HOTELS_SHARE_FLAGS,
  );
  const [location, checkIn, checkOut, ...extra] = positional;
  if (!location || !checkIn || !checkOut) {
    throw new Error(HOTELS_SHARE_USAGE);
  }
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}\n${HOTELS_SHARE_USAGE}`);
  }
  // Not `locationFields`: its message names hotelId and lat,lng, the two shapes this command refuses.
  if (!/^[A-Z]{3}$/.test(location)) {
    throw new Error(
      `A durable link needs a city, so "${location}" cannot be shared: wego.com serves no hotel-level or coordinate search URL. Pass an uppercase 3-letter city code, which \`${PROG} places <name> --types city\` reports as code.`,
    );
  }
  const query: WireQueryValues<"getHotelSearchLink"> = {
    cityCode: location,
    checkIn,
    checkOut,
  };
  applyShareOccupancy(query, single);
  const currency = single.get("--currency");
  if (currency) query.currency = currency;
  const locale = single.get("--locale");
  if (locale) query.locale = locale;
  const site = single.get("--site");
  if (site) query.siteCode = site;
  return query;
}

async function hotelsShare(
  config: CliConfig,
  args: string[],
  deps: HotelsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(HOTELS_SHARE_USAGE);
    return 0;
  }
  let query: WireQueryValues<"getHotelSearchLink">;
  try {
    query = parseHotelsShareArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  const settings = await deps.loadSettings();
  // A durable link hands its currency to everyone it reaches, so it inherits the stored preferences like `flights share`.
  const withPrefs = applyPreferences(query, settings);
  const result = await withAccessToken(config, deps, (accessToken, market) =>
    deps.fetchHotelSearchLink(config.apiBaseUrl, accessToken, {
      ...withPrefs,
      siteCode: resolveCliSite(query.siteCode, settings.site, market).siteCode,
    }),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

/** Enum/bound guards for the hotels `results`/`details` flags, mirroring
 *  apps/api hotels/schema.ts (pollHotelsQuerySchema) so the SAME user typo that
 *  flights catches locally (`--page abc`, `--sort cheapest`) also
 *  fails here as a usage error (exit 2) BEFORE any network call, instead of
 *  round-tripping to the API's 400 `validation_failed` (exit 6). Page/page-size
 *  reuse the shared MAX_PAGE/MAX_PAGE_SIZE caps. */
const HOTEL_SORTS = new Set([
  "relevance",
  "price_asc",
  "price_desc",
  "star_desc",
  "review_score_desc",
  "guest_rating_desc",
  "distance_asc",
]);
/** The guest cohorts `--guest-type` accepts, mirroring the published
 *  `HOTEL_GUEST_RATING_GROUPS`. Deliberately NOT the `hotels reviews`
 *  `--guest-type` vocabulary: that command reads a different upstream and spells
 *  the cohorts differently (`family_with_children`, `solo_traveller`, and an
 *  `extended_group` with no counterpart here), so one shared set would accept a
 *  value this read cannot answer. Enum-checked locally for the same reason
 *  `--sort` is — a typo fails before the call, naming the four valid values. */
const HOTEL_GUEST_TYPES = new Set(["business", "couple", "family", "solo"]);
/** The `default|detail` projection axis, shared by the three entity reads that
 *  publish it: `GET /v1/flights/trips/{tripId}`, `GET /v1/hotels/{hotelId}` and
 *  `…/reviews` (`apps/api/AGENTS.md` → Wire conventions). ONE constant, because
 *  three copies could drift into three different `--view` vocabularies for one
 *  published enum. Deliberately NOT used for the two `results` reads: their `view`
 *  is a one-value enum (`card`) since #1308, so a flag there would accept only the
 *  default it already sends. */
const DETAIL_VIEWS = new Set(["default", "detail"]);
const BOOL_FLAG_VALUES = new Set(["true", "false"]);

/** Reject a single flag value outside `allowed`, mirroring how flights' `--sort`
 *  guards its value (same message shape) — a typo fails locally before any call. */
function validateEnumValue(
  value: string,
  allowed: Set<string>,
  flag: string,
): string {
  if (!allowed.has(value)) {
    throw new Error(`${flag} must be one of ${[...allowed].join(", ")}`);
  }
  return value;
}

/** Validate one hotels `results` flag value client-side, returning the wire
 *  value unchanged when valid. `--page`/`--page-size` are int-parsed against the
 *  API caps; `--sort`/`--guest-type`/`--refundable`/`--deals-only` are enum-checked;
 *  `--min-guest-rating` is range-checked (0-10), so `abc`, `-1`, `11` and
 *  `Infinity` fail here rather than spending a request to be told the same thing.
 *  Any other flag (star/price/text filters) passes through untouched — the API
 *  validates those. `--min-review-score` is among them and takes the SAME 0-10
 *  range unchecked; that gap predates this flag and is left alone here rather
 *  than widened into an unrelated behaviour change.
 *
 *  The guest-type/min-guest-rating PAIRING rule stays with the API on purpose: it
 *  is cross-field, so a second copy here could drift from the one the API
 *  actually enforces, and the API already answers it with a 400 naming the
 *  missing half. */
function validateHotelResultsFlag(flag: string, value: string): string {
  switch (flag) {
    case "--page":
      return String(parseIntArg(value, "--page", MAX_PAGE));
    case "--page-size":
      return String(parseIntArg(value, "--page-size", MAX_PAGE_SIZE));
    case "--sort":
      return validateEnumValue(value, HOTEL_SORTS, "--sort");
    case "--guest-type":
      return validateEnumValue(value, HOTEL_GUEST_TYPES, "--guest-type");
    case "--min-guest-rating":
      return String(parseRangedFloatArg(value, "--min-guest-rating", 0, 10));
    case "--refundable":
      return validateEnumValue(value, BOOL_FLAG_VALUES, "--refundable");
    case "--deals-only":
      return validateEnumValue(value, BOOL_FLAG_VALUES, "--deals-only");
    default:
      return value;
  }
}

/** Flag → published query-parameter name. The value type is the contract's own
 *  parameter set (Check C, #1300): rename a parameter in `apps/api` and this
 *  table stops compiling, naming the stale key. */
export const RESULTS_FLAG_TO_PARAM: Record<
  string,
  WireQuery<"getHotelSearchResults">
> = {
  "--page": "page",
  "--page-size": "pageSize",
  "--sort": "sort",
  "--min-star": "min-star",
  "--max-star": "max-star",
  "--min-review-score": "min-review-score",
  "--guest-type": "guest-type",
  "--min-guest-rating": "min-guest-rating",
  "--min-price": "min-price",
  "--max-price": "max-price",
  "--refundable": "refundable",
  "--rate-types": "rate-types",
  "--deals-only": "deals-only",
  "--amenities": "amenities",
  "--property-types": "property-types",
  "--brands": "brands",
  "--chains": "chains",
  "--districts": "districts",
  "--currency": "currency",
  "--locale": "locale",
};

async function hotelsResults(
  config: CliConfig,
  args: string[],
  deps: HotelsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(HOTELS_RESULTS_USAGE);
    return 0;
  }
  let searchId: string;
  let wait = false;
  const query: HotelResultsQuery = {};
  try {
    // `--wait` is a valueless bool; the value flags are the RESULTS_FLAG_TO_PARAM
    // keys. `--wait=x` throws "takes no value" (handled by the shared tokenizer).
    const { positional, single, bools } = tokenizeFlagSets(
      args,
      HOTELS_RESULTS_USAGE,
      new Set(Object.keys(RESULTS_FLAG_TO_PARAM)),
      EMPTY_SET,
      new Set(["--wait"]),
    );
    wait = bools.has("--wait");
    searchId = positional[0];
    if (!searchId) throw new Error(HOTELS_RESULTS_USAGE);
    if (positional.length > 1) {
      throw new Error(
        `Unexpected argument: ${positional[1]}\n${HOTELS_RESULTS_USAGE}`,
      );
    }
    for (const [flag, value] of single) {
      // Validate the guarded flags locally (page/page-size/sort/refundable)
      // so the same typo flights catches exits 2 here too, not the API's 400 → 6.
      query[RESULTS_FLAG_TO_PARAM[flag]] = validateHotelResultsFlag(
        flag,
        value,
      );
    }
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // ②+③ through the shared engine: `--wait` runs the SAME count-convergence
  // settle `hotels search` uses (so both paths share one recipe, symmetric with
  // flights — CLI-5); a bare read is a single snapshot stamped `unsettled`
  // (issue #1084). The `HOTELS` vertical owns the 404-translation + empty-page
  // note.
  // The read that used to silently revert to the API's USD default: it now
  // inherits the stored currency, so a page read carries the same unit the
  // search was created in (issue #1386). `site` cannot change on a read, so no
  // site pair is emitted here - but the currency rung still decided this page's
  // unit, so it is reported the way the two `search`es report theirs (#1400).
  const settings = await deps.loadSettings();
  const currency = resolveCliCurrency(query.currency, settings.currency);
  return runResults(
    HOTELS,
    searchId,
    applyPreferences({ ...query, currency: currency.currency }, settings, [
      "locale",
    ]),
    wait,
    DEFAULT_SETTLE_BUDGET,
    makeEngine(config, deps),
    { currencyCodeSource: currency.source },
  );
}

const DETAILS_FLAGS = new Set(["--locale", "--view"]);

/** Shared by `details` and `reviews`: both 404 on the same bad id, so the
 *  recovery they name must not drift apart. */
const UNKNOWN_HOTEL_MESSAGE = `Unknown hotel id – check \`${PROG} hotels results\` output.`;

async function hotelsDetails(
  config: CliConfig,
  args: string[],
  deps: HotelsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(HOTELS_DETAILS_USAGE);
    return 0;
  }
  let hotelId: number;
  const query: WireQueryValues<"getHotel"> = {};
  try {
    const { positional, single } = tokenizeFlagSets(
      args,
      HOTELS_DETAILS_USAGE,
      DETAILS_FLAGS,
    );
    // Reject the structural "too many args" error before parsing the id, so an
    // invalid id doesn't mask it (matches `hotels results`).
    if (positional.length > 1) {
      throw new Error(
        `Unexpected argument: ${positional[1]}\n${HOTELS_DETAILS_USAGE}`,
      );
    }
    hotelId = parseIntArg(positional[0] ?? "", "hotelId");
    const locale = single.get("--locale");
    if (locale) query.locale = locale;
    const view = single.get("--view");
    // Guard --view (default|detail) locally — a typo exits 2
    // before the network call rather than the API's 400 → exit 6.
    if (view) query.view = validateEnumValue(view, DETAIL_VIEWS, "--view");
  } catch (err) {
    // Print the caught message (bad hotelId's "must be a positive integer",
    // an unknown flag, or the --view guard) like every other command, instead of
    // swallowing it and printing bare usage (CLI-3).
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // Static detail carries no price, so locale is the only preference that applies.
  const detailQuery = applyPreferences(query, await deps.loadSettings(), [
    "locale",
  ]);
  const result = await withAccessToken(config, deps, (token) =>
    deps
      .fetchHotelDetails(config.apiBaseUrl, token, hotelId, detailQuery)
      .catch(translateNotFound(UNKNOWN_HOTEL_MESSAGE)),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

const REVIEWS_FLAGS = new Set([
  "--topics",
  "--guest-type",
  "--sort",
  "--page",
  "--page-size",
  "--view",
  "--locale",
]);

const REVIEW_SORTS = new Set(["posted_at_desc", "rating_desc", "rating_asc"]);

const REVIEW_GUEST_TYPES = new Set([
  "couple",
  "family_with_children",
  "solo_traveller",
  "extended_group",
]);

/** Flag → published query-parameter name. Typed against the contract's own
 *  parameter set (Check C), so the kebab/camel split below is the API's, not a
 *  guess: `guest-type` is a net-new filter knob, `pageSize` mirrors a field the
 *  surface already accepts. */
const REVIEWS_FLAG_TO_PARAM: Record<string, WireQuery<"getHotelReviews">> = {
  "--topics": "topics",
  "--guest-type": "guest-type",
  "--sort": "sort",
  "--page": "page",
  "--page-size": "pageSize",
  "--view": "view",
  "--locale": "locale",
};

/** Validate one `reviews` flag client-side, so a typo costs no request (exit 2
 *  rather than the API's 400 → 6). Ranges are rejected, never clamped. */
function validateHotelReviewsFlag(flag: string, value: string): string {
  switch (flag) {
    case "--page":
      return String(parseIntArg(value, "--page", MAX_PAGE));
    case "--page-size":
      return String(parseIntArg(value, "--page-size", MAX_PAGE_SIZE));
    case "--sort":
      return validateEnumValue(value, REVIEW_SORTS, "--sort");
    case "--guest-type":
      return validateEnumValue(value, REVIEW_GUEST_TYPES, "--guest-type");
    case "--view":
      return validateEnumValue(value, DETAIL_VIEWS, "--view");
    case "--topics": {
      // The API splits this on commas and requires one non-empty term, so `,`
      // or `  ` reaches it as an empty list and 400s. Re-split here on the same
      // rule and keep the promise above: a typo costs no request.
      const terms = splitCsv(value);
      if (terms.length === 0) {
        throw new Error("--topics needs at least one non-empty topic");
      }
      return terms.join(",");
    }
    default:
      return value;
  }
}

async function hotelsReviews(
  config: CliConfig,
  args: string[],
  deps: HotelsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(HOTELS_REVIEWS_USAGE);
    return 0;
  }
  let hotelId: number;
  const query: WireQueryValues<"getHotelReviews"> = {};
  try {
    const { positional, single } = tokenizeFlagSets(
      args,
      HOTELS_REVIEWS_USAGE,
      REVIEWS_FLAGS,
    );
    if (positional.length > 1) {
      throw new Error(
        `Unexpected argument: ${positional[1]}\n${HOTELS_REVIEWS_USAGE}`,
      );
    }
    hotelId = parseIntArg(positional[0] ?? "", "hotelId");
    for (const [flag, param] of Object.entries(REVIEWS_FLAG_TO_PARAM)) {
      const raw = single.get(flag);
      if (raw !== undefined) query[param] = validateHotelReviewsFlag(flag, raw);
    }
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // Reviews carry no price, so locale is the only preference that applies.
  const reviewsQuery = applyPreferences(query, await deps.loadSettings(), [
    "locale",
  ]);
  const result = await withAccessToken(config, deps, (token) =>
    deps
      .fetchHotelReviews(config.apiBaseUrl, token, hotelId, reviewsQuery)
      .catch(translateNotFound(UNKNOWN_HOTEL_MESSAGE)),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

// The dates form's own flags. `--search` discards every one of them, so the two
// forms together is a usage error, not a silent precedence.
const ROOMS_DATES_FLAGS = [
  "--check-in",
  "--check-out",
  "--adults",
  "--children",
  "--children-ages",
  "--rooms",
  "--site",
] as const;

const ROOMS_FLAGS = new Set<string>([
  "--search",
  ...ROOMS_DATES_FLAGS,
  "--currency",
  "--locale",
]);

export interface RoomsPlan {
  hotelId: number;
  searchId?: string;
  createBody?: HotelsSearchBody;
  ratesQuery: WireQueryValues<"getHotelRates">;
}

export function parseRoomsArgs(args: string[]): RoomsPlan {
  const { positional, single } = tokenizeFlagSets(
    args,
    HOTELS_ROOMS_USAGE,
    ROOMS_FLAGS,
  );
  // Reject the structural "too many args" error before parsing the id, so an
  // invalid id doesn't mask it (matches `hotels results`).
  const [idArg, datesFrom, datesTo, ...extra] = positional;
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}\n${HOTELS_ROOMS_USAGE}`);
  }
  const hotelId = parseIntArg(idArg ?? "", "hotelId");
  const ratesQuery: WireQueryValues<"getHotelRates"> = {};
  const currency = single.get("--currency");
  if (currency) ratesQuery.currency = currency;
  const locale = single.get("--locale");
  if (locale) ratesQuery.locale = locale;

  const flagCheckIn = single.get("--check-in");
  const flagCheckOut = single.get("--check-out");
  const search = single.get("--search");
  if (search) {
    const both = [
      ...(datesFrom === undefined ? [] : ["the positional dates"]),
      ...ROOMS_DATES_FLAGS.filter((flag) => single.has(flag)),
    ];
    if (both.length > 0) {
      throw new Error(
        `rooms takes either --search <searchId> or ${both.join(", ")}, not both\n${HOTELS_ROOMS_USAGE}`,
      );
    }
    return { hotelId, searchId: search, ratesQuery };
  }

  const { checkIn, checkOut } = resolveRoomsDates(
    datesFrom,
    datesTo,
    flagCheckIn,
    flagCheckOut,
  );
  const createBody: HotelsSearchBody = { hotelId, checkIn, checkOut };
  // `applyOccupancyFlags` is the SINGLE writer of --site/--currency/--locale on
  // the create body: it copies all three, so an explicit flag reaches the create
  // as well as the rates read and never loses to a stored setting for half the
  // operation. Do NOT re-copy them here — two reviewers read this function alone
  // and reported the flags as dropped. `integration/hotels.test.ts` pins all three.
  applyOccupancyFlags(createBody, single);
  return { hotelId, createBody, ratesQuery };
}

// Positional dates and the flag pair are one form spelled two ways.
function resolveRoomsDates(
  datesFrom: string | undefined,
  datesTo: string | undefined,
  flagCheckIn: string | undefined,
  flagCheckOut: string | undefined,
): { checkIn: string; checkOut: string } {
  if (datesFrom !== undefined && (flagCheckIn || flagCheckOut)) {
    throw new Error(
      `rooms takes the dates as positional arguments or as --check-in/--check-out, not both\n${HOTELS_ROOMS_USAGE}`,
    );
  }
  const checkIn = datesFrom ?? flagCheckIn;
  const checkOut = datesTo ?? flagCheckOut;
  if (!checkIn || !checkOut) {
    throw new Error(
      `rooms needs <checkIn> <checkOut> (or --search <searchId>)\n${HOTELS_ROOMS_USAGE}`,
    );
  }
  return { checkIn, checkOut };
}

/** Resolve the searchId for a rooms read: reuse `--search`, else mint a
 *  hotel-scoped search (an item-14 create) and return its id. */
async function resolveRoomsSearchId(
  config: CliConfig,
  deps: HotelsDeps,
  plan: RoomsPlan,
  settings: UserSettings,
  /** The currency the caller already resolved, so the mint and the rates read it
   *  feeds go out in ONE unit — the invariant the merge-before-create held while
   *  `applyPreferences` filled both from the same file. */
  currency: string | undefined,
): Promise<
  | {
      ok: true;
      searchId: string;
      occupancy?: PricedOccupancy;
      siteCode?: string;
      siteCodeSource?: CliSiteSource;
    }
  | { ok: false; code: number }
> {
  // Reusing an existing --search does no create, so there's no occupancy echo —
  // and no market to resolve either: that search already fixed one, so a stored
  // `site` must NOT reach this path (it would claim a market the rates aren't in).
  if (plan.searchId) return { ok: true, searchId: plan.searchId };
  let siteSource: CliSiteSource = "default";
  const created = await withAccessToken(config, deps, (token, market) => {
    const cb = applyPreferences(
      { ...(plan.createBody as HotelsSearchBody), currency },
      settings,
      ["locale"],
    );
    // Same --site resolution as the other funnels: explicit → stored setting →
    // id_token market → nothing (API floors US).
    const resolvedSite = resolveCliSite(cb.siteCode, settings.site, market);
    siteSource = resolvedSite.source;
    return deps.createHotelSearch(config.apiBaseUrl, token, {
      ...cb,
      siteCode: resolvedSite.siteCode,
    });
  });
  if (!created.ok) return { ok: false, code: created.code };
  // Carry the create's occupancy echo (resolved child ages) so rooms can
  // surface it alongside the rates (issue #1114).
  return {
    ok: true,
    searchId: created.value.searchId,
    occupancy: created.value.occupancy,
    // Carry the market too. This form MINTS a search, so a stored `site` can
    // decide the point of sale, and an unreported market is exactly the silent
    // decision issue #1386 exists to remove. Emitted as a PAIR, like the two
    // search verticals: a legacy API that omits the echo must not leave an
    // orphan source behind.
    ...(created.value.siteCode === undefined
      ? {}
      : { siteCode: created.value.siteCode, siteCodeSource: siteSource }),
  };
}

async function hotelsRooms(
  config: CliConfig,
  args: string[],
  deps: HotelsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(HOTELS_ROOMS_USAGE);
    return 0;
  }
  let plan: RoomsPlan;
  try {
    plan = parseRoomsArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  const settings = await deps.loadSettings();
  // ONE currency decision for both calls this command can make, resolved before
  // either so the optional mint and the rates read cannot disagree (#1400).
  const currency = resolveCliCurrency(
    plan.ratesQuery.currency,
    settings.currency,
  );
  const resolved = await resolveRoomsSearchId(
    config,
    deps,
    plan,
    settings,
    currency.currency,
  );
  if (!resolved.ok) return resolved.code;
  const ratesQuery = applyPreferences(
    {
      ...plan.ratesQuery,
      searchId: resolved.searchId,
      currency: currency.currency,
    },
    settings,
    ["locale"],
  );
  const mintedSearch = plan.searchId === undefined;
  const result = await withAccessToken(config, deps, (token) => {
    const read = () =>
      deps
        .fetchHotelRates(config.apiBaseUrl, token, plan.hotelId, ratesQuery)
        .catch(
          translateNotFound(
            `Search expired – re-run \`${PROG} hotels rooms\` with fresh dates.`,
          ),
        );
    return settleRates(read, deps.sleep);
  });
  if (!result.ok) {
    // When we minted the search ourselves (no --search given), a rates-read
    // failure still leaves a valid searchId the user can retry with, so surface
    // it as a re-run hint instead of dropping it (mirrors `wego hotels search`).
    if (mintedSearch) {
      deps.error(
        `Search created – re-run: ${PROG} hotels rooms ${plan.hotelId} --search ${resolved.searchId}`,
      );
    }
    return result.code;
  }
  const { snapshot, state } = result.value;
  // Surface the priced occupancy (resolved child ages) the mint echoed, so the
  // audited ages reach stdout alongside the rates (issue #1114). Absent when a
  // caller-supplied --search was reused (no create) or on a legacy API.
  printJson(
    {
      // Both rooms forms are priced, so both report the currency rung — unlike
      // the market, which only the minting form may decide.
      ...withCurrencyProvenance(snapshot, currency.source),
      settled: state,
      ...(resolved.occupancy === undefined
        ? {}
        : { occupancy: resolved.occupancy }),
      // The market this form minted the search in, with the layer that decided
      // it. Absent on the --search form, which reuses a market already fixed.
      ...(resolved.siteCode === undefined
        ? {}
        : {
            siteCode: resolved.siteCode,
            siteCodeSource: resolved.siteCodeSource,
          }),
    },
    deps,
  );
  if (state === "budget_exhausted") {
    // stderr hint stops an agent treating an unsettled snapshot as definitive.
    deps.error(
      `Rates were still aggregating – re-run: ${PROG} hotels rooms ${plan.hotelId} --search ${resolved.searchId}`,
    );
  } else if ((snapshot.rates?.length ?? 0) === 0) {
    // A converged empty is this search's answer, not the hotel's; exit stays 0.
    deps.error(
      `No rates in this search – that is not proof the hotel has no rooms. Re-run \`${PROG} hotels rooms ${plan.hotelId} <checkIn> <checkOut>\` to mint a fresh search.`,
    );
  }
  return 0;
}

/** Flag → published query-parameter name, bound to the contract like the results
 *  table above. */
const BOOKING_FLAG_TO_PARAM: Record<
  string,
  WireQuery<"getHotelRateBookingLink">
> = {
  "--search": "searchId",
  "--site": "siteCode",
  "--locale": "locale",
  "--country": "countryCode",
};

const BOOKING_FLAGS = new Set([
  ...Object.keys(BOOKING_FLAG_TO_PARAM),
  "--rate",
]);

async function hotelsBookingLink(
  config: CliConfig,
  args: string[],
  deps: HotelsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(HOTELS_BOOKING_LINK_USAGE);
    return 0;
  }
  let hotelId: number;
  let rateId: string;
  const query: WireQueryValues<"getHotelRateBookingLink"> = {};
  try {
    const { positional, single } = tokenizeFlagSets(
      args,
      HOTELS_BOOKING_LINK_USAGE,
      BOOKING_FLAGS,
    );
    // Reject the structural "too many args" error before parsing the id, so an
    // invalid id doesn't mask it (matches `hotels results`).
    if (positional.length > 1) {
      throw new Error(
        `Unexpected argument: ${positional[1]}\n${HOTELS_BOOKING_LINK_USAGE}`,
      );
    }
    hotelId = parseIntArg(positional[0] ?? "", "hotelId");
    const rate = single.get("--rate");
    if (!rate) throw new Error("booking-link requires --rate <rateId>");
    rateId = rate;
    for (const [flag, value] of single) {
      const param = BOOKING_FLAG_TO_PARAM[flag];
      if (!param) continue;
      query[param] =
        flag === "--country"
          ? parseCountryCode(value, "--country", HOTELS_BOOKING_LINK_USAGE)
          : value;
    }
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // Locale inherits; the hotel checkout URL carries no currency param.
  const settings = await deps.loadSettings();
  const linkQuery = applyPreferences(query, settings, ["locale"]);
  const result = await withAccessToken(config, deps, (token, market) => {
    // Same --site resolution: explicit → stored setting → id_token market →
    // nothing (API US floor).
    const site = resolveCliSite(query.siteCode, settings.site, market).siteCode;
    return deps.fetchHotelBookingLink(
      config.apiBaseUrl,
      token,
      hotelId,
      rateId,
      site ? { ...linkQuery, siteCode: site } : linkQuery,
    );
  });
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

/** `wego hotels <sub> ...` — dispatch to the sub-command handlers. */
export async function hotels(
  config: CliConfig,
  args: string[],
  deps: HotelsDeps,
): Promise<number> {
  const sub = args[0];
  // Same help short-circuit as `flights` (issue #1119): recognized BEFORE
  // sub-command matching, so it never falls into the `default:` arm. Uses the
  // shared `isHelpArg` so the group and leaf levels can't drift.
  if (isHelpArg(args)) {
    deps.log(HOTELS_USAGE);
    return 0;
  }
  const rest = args.slice(1);
  switch (sub) {
    case "search":
      return hotelsSearch(config, rest, deps);
    case "results":
      return hotelsResults(config, rest, deps);
    case "details":
      return hotelsDetails(config, rest, deps);
    case "reviews":
      return hotelsReviews(config, rest, deps);
    case "rooms":
      return hotelsRooms(config, rest, deps);
    case "booking-link":
      return hotelsBookingLink(config, rest, deps);
    case "share":
      return hotelsShare(config, rest, deps);
    default:
      deps.error(HOTELS_USAGE);
      return EXIT.USAGE;
  }
}

// --- flights sub-commands (search/results/trip, issue #988) ------------------

async function flightsSearch(
  config: CliConfig,
  args: string[],
  deps: FlightsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(SEARCH_USAGE);
    return 0;
  }
  let body: CreateFlightSearchBody;
  try {
    body = parseFlightSearchArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // ①+③ through the shared engine (issue #1084): `flights search` now BLOCKS to
  // settled — the single behaviour change that removes the flights↔hotels
  // asymmetry — and stamps `settled`. The `FLIGHTS` vertical (no completion flag
  // → rides `snapshotFareCount` + item-presence) owns the site resolution and
  // the empty-page hint; create + settle-read run in SEPARATE authed calls
  // (inside `runSearch`) so a mid-settle 401 never re-POSTs a second search.
  // Locale from the stored settings (see `hotelsSearch`); the vertical resolves
  // `site` AND `currency` and stamps both sources.
  const settings = await deps.loadSettings();
  const code = await runSearch(
    FLIGHTS,
    applyPreferences(body, settings, ["locale"]),
    DEFAULT_SETTLE_BUDGET,
    makeEngine(config, deps),
  );
  noteCurrencyDefault(code, body.currency, settings, deps);
  return code;
}

async function flightsResults(
  config: CliConfig,
  args: string[],
  deps: FlightsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(RESULTS_USAGE);
    return 0;
  }
  let parsed: { searchId: string; query: FlightResultsQuery; wait: boolean };
  try {
    parsed = parseFlightResultsArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  // ②+③ through the shared engine: `--wait` blocks to settled on the same
  // count-convergence rule hotels uses (now one loop, not two); a bare read is a
  // single snapshot stamped `unsettled` (issue #1084). The whole `--wait` settle
  // runs inside one authed call, so a mid-settle 401 refresh restarts the
  // (idempotent) poll — worst case ~doubling the wait, accepted for simplicity.
  // Same as hotels: the bare read inherits the stored currency instead of
  // falling back to USD (the 216 SAR → 58 USD measurement in issue #1386), and
  // reports which rung that was (#1400).
  const settings = await deps.loadSettings();
  const currency = resolveCliCurrency(parsed.query.currency, settings.currency);
  return runResults(
    FLIGHTS,
    parsed.searchId,
    applyPreferences(
      { ...parsed.query, currency: currency.currency },
      settings,
      ["locale"],
    ),
    parsed.wait,
    DEFAULT_SETTLE_BUDGET,
    makeEngine(config, deps),
    { currencyCodeSource: currency.source },
  );
}

async function flightsTrip(
  config: CliConfig,
  args: string[],
  deps: FlightsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(TRIP_USAGE);
    return 0;
  }
  let parsed: {
    tripId: string;
    searchId: string;
    currency?: string;
    locale?: string;
    view?: string;
  };
  try {
    parsed = parseFlightTripArgs(args);
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  const settings = await deps.loadSettings();
  const currency = resolveCliCurrency(parsed.currency, settings.currency);
  const trip = applyPreferences(parsed, settings, ["locale"]);
  const result = await withAccessToken(config, deps, (accessToken) =>
    deps
      .fetchFlightTrip(
        config.apiBaseUrl,
        accessToken,
        trip.tripId,
        trip.searchId,
        currency.currency,
        trip.locale,
        trip.view,
      )
      .catch(translateNotFound("Trip not found for this search.")),
  );
  if (!result.ok) return result.code;
  return printJson(withCurrencyProvenance(result.value, currency.source), deps);
}

async function flightsExperience(
  config: CliConfig,
  args: string[],
  deps: FlightsDeps,
): Promise<number> {
  if (isHelpArg(args)) {
    deps.log(EXPERIENCE_USAGE);
    return 0;
  }
  let tripId: string;
  const query: WireQueryValues<"getTripExperience"> = {};
  try {
    const { positional, single } = tokenizeFlagSets(
      args,
      EXPERIENCE_USAGE,
      new Set(["--search"]),
    );
    const [first, ...extra] = positional;
    if (!first) throw new Error(EXPERIENCE_USAGE);
    if (extra.length > 0) {
      throw new Error(`Unexpected argument: ${extra[0]}\n${EXPERIENCE_USAGE}`);
    }
    tripId = first;
    const searchId = single.get("--search");
    if (searchId) query.searchId = searchId;
  } catch (err) {
    deps.error(errorMessage(err));
    return EXIT.USAGE;
  }
  const result = await withAccessToken(config, deps, (accessToken) =>
    deps
      .fetchTripExperience(config.apiBaseUrl, accessToken, tripId, query)
      .catch(
        translateNotFound(
          "Unknown trip, or its search has expired – search again and re-open the trip.",
        ),
      ),
  );
  if (!result.ok) return result.code;
  return printJson(result.value, deps);
}

/** Rethrow a 401 untouched (so `withAccessToken` can refresh + retry) but turn an
 *  API 404 into a friendly message. Any other error passes through. Exported so
 *  the vertical configs (`verticals.ts`) reuse the SAME 404-translation for their
 *  results reads. */
export function translateNotFound(message: string): (err: unknown) => never {
  return (err) => {
    if (err instanceof UnauthorizedError) throw err;
    // The shared `authedJsonGet` throws a typed `NotFoundError` on a 404 (an
    // expired search / unknown trip); older callers matched the generic
    // `failed: 404` message, so accept both. Re-throw a typed `NotFoundError`
    // (not a plain `Error`) so the friendly message still maps to
    // EXIT.NOT_FOUND (4) — a script can tell an expired id from a generic fault.
    if (
      err instanceof NotFoundError ||
      (err instanceof Error && /failed: 404\b/.test(err.message))
    ) {
      const label = err instanceof NotFoundError ? err.label : "not_found";
      throw new NotFoundError(label, message);
    }
    throw err;
  };
}

export interface LogoutDeps extends CommandIo {
  clearCredentials: typeof clearCredentials;
  /** Ends the analytics session too, so the next user does not inherit it. */
  clearSession: () => Promise<void>;
}

export async function logout(
  config: CliConfig,
  deps: LogoutDeps,
): Promise<number> {
  await deps.clearCredentials(config.credentialsPath);
  // Best-effort: credentials are already gone, so this must not fail the logout.
  await deps.clearSession().catch((err) => {
    deps.error(
      `could not clear the analytics session: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  deps.log("Logged out – stored credentials removed.");
  return 0;
}

// --- flights arg parsing ----------------------------------------------------

/** The `--cabin` values, typed as the contract's own cabin set (Check C, #1300).
 *  `ReadonlySet<FlightCabin>` is what makes `CABINS.has(x)` narrow `x` to a valid
 *  cabin, so the client-side guard and the API's enum cannot drift.
 *
 *  Built from a `Record<FlightCabin, true>` because that is what makes the drift
 *  claim symmetric. `new Set<FlightCabin>([…])` only catches a REMOVED or renamed
 *  member: any subset satisfies it, so a cabin ADDED to the contract would
 *  compile here and the CLI would reject a value the API accepts (exit 2, no
 *  network call, a user blocked on a valid cabin). A missing record key is a
 *  compile error. */
const CABIN_MEMBERS: Record<FlightCabin, true> = {
  economy: true,
  premium_economy: true,
  business: true,
  first: true,
};
const CABINS: ReadonlySet<FlightCabin> = new Set(
  Object.keys(CABIN_MEMBERS) as FlightCabin[],
);

/** Narrow a raw `--cabin` value to a cabin the API accepts. */
function isFlightCabin(value: string): value is FlightCabin {
  return (CABINS as ReadonlySet<string>).has(value);
}
const FLIGHT_SORTS = new Set([
  "score_desc",
  "price_asc",
  "duration_asc",
  "leg1_departure_time_asc",
  "leg1_departure_time_desc",
  "leg2_departure_time_asc",
  "leg2_departure_time_desc",
]);

// Client-side enum guards mirroring apps/api flights/schema.ts
// (pollFlightsQuerySchema) — validated before any network call, like --sort.
const FLIGHT_DEPARTURE_BLOCKS = new Set([
  "midnight",
  "morning",
  "afternoon",
  "night",
]);
const FLIGHT_BOOKING_TYPES = new Set(["wego", "airline"]);
const FLIGHT_AIRLINES_MATCHES = new Set(["any", "all"]);

/** A minute-of-day (0-1439) `min-max` outbound-departure range. `min > max`
 *  wraps midnight (e.g. `1320-360` = 22:00–06:00), matching the API's
 *  `departureMinutes`/`inRange` semantics. */
/** `flag` names the offending flag in the message: four flags share this shape,
 *  so a fixed `--departure-range` would send the caller to the wrong one. */
function validateDepartureRange(
  raw: string,
  flag = "--departure-range",
): string {
  const parts = raw.split("-").map((p) => p.trim());
  const isMinute = (s: string | undefined): s is string =>
    s !== undefined && /^\d+$/.test(s) && Number(s) >= 0 && Number(s) <= 1439;
  if (parts.length !== 2 || !isMinute(parts[0]) || !isMinute(parts[1])) {
    throw new Error(
      `${flag} must be min-max minutes of the day (each 0-1439), e.g. 1320-360 to wrap midnight (22:00-06:00)`,
    );
  }
  return `${Number(parts[0])}-${Number(parts[1])}`;
}

/** Reject any list value outside `allowed`, mirroring how `--sort` guards its
 *  single value — so a typo fails locally before any network call. */
function validateEnumList(
  values: string[],
  allowed: Set<string>,
  flag: string,
): string[] {
  const bad = values.find((v) => !allowed.has(v));
  if (bad !== undefined) {
    throw new Error(
      `${flag} must be one of ${[...allowed].join(", ")} (got "${bad}")`,
    );
  }
  return values;
}

interface FlagTokens {
  positional: string[];
  /** Single-valued flags (last wins). */
  single: Map<string, string>;
  /** List-valued flags (repeat and/or comma-separate accumulate). */
  list: Map<string, string[]>;
  /** Valueless boolean flags that were present (e.g. `--wait`). */
  bools: Set<string>;
}

/** Generic `--flag[=value]` tokenizer. `single`/`list` name the recognized flags;
 *  an unknown flag or a flag missing its value throws a usage error. */
/** Resolve a `--flag`'s value at index `i`: inline (`--flag=v`) or the next arg
 *  (`--flag v`, only when it isn't itself an option). Returns the value + the
 *  index to continue scanning from. Throws when the value is missing. */
function readFlagValue(
  args: string[],
  i: number,
  name: string,
  eq: number,
): { value: string; next: number } {
  if (eq !== -1) {
    const value = args[i].slice(eq + 1);
    if (value === "") throw new Error(`${name} requires a value`);
    return { value, next: i };
  }
  const value = args[i + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return { value, next: i + 1 };
}

/** Mutable accumulator for {@link tokenizeFlagSets}. */
interface FlagAcc {
  positional: string[];
  single: Map<string, string>;
  list: Map<string, string[]>;
  bools: Set<string>;
}

/** The flag-name sets a token is classified against. A name in `known` that is
 *  neither `bool` nor `list` is a single-valued flag — there is no separate
 *  `single` set to check, so it isn't carried here. `usage` is appended to the
 *  unknown-flag error (the one unified error format, CLI-2). */
interface FlagSets {
  known: Set<string>;
  list: ReadonlySet<string>;
  bool: ReadonlySet<string>;
  usage: string;
}

/** Process the token at index `i` into `acc`; returns the index to continue the
 *  scan from (advanced past a consumed `--flag value` pair). Extracted from the
 *  loop to keep each function's cognitive complexity within the Sonar gate. */
function consumeFlagToken(
  args: string[],
  i: number,
  sets: FlagSets,
  acc: FlagAcc,
): number {
  const arg = args[i];
  if (!arg.startsWith("--")) {
    acc.positional.push(arg);
    return i;
  }
  const eq = arg.indexOf("=");
  const name = eq === -1 ? arg : arg.slice(0, eq);
  if (!sets.known.has(name)) {
    throw new Error(`Unknown option: ${name}\n${sets.usage}`);
  }
  if (sets.bool.has(name)) {
    if (eq !== -1) throw new Error(`${name} takes no value`);
    acc.bools.add(name);
    return i;
  }
  const { value, next } = readFlagValue(args, i, name, eq);
  if (sets.list.has(name)) {
    acc.list.set(name, (acc.list.get(name) ?? []).concat(splitCsv(value)));
  } else {
    acc.single.set(name, value);
  }
  return next;
}

/**
 * The single argv tokenizer for every `wego` command (CLI-2 — collapsed the four
 * former tokenizers `tokenizePlacesArgs`/`tokenizeFlags`/`parseFlagArgs`/this
 * onto one). Splits argv into positionals + single-valued flags (`--flag value`/
 * `--flag=value`, last wins) + repeatable comma-split `list` flags (`--airlines
 * SQ,TR`, `--types city,airport`) + valueless `bool` flags (`--wait`; `--wait=x`
 * throws). `list`/`bool` default empty for commands that use neither. An unknown
 * flag throws the one unified error: `Unknown option: --x` + the command's usage.
 */
function tokenizeFlagSets(
  args: string[],
  usage: string,
  single: ReadonlySet<string>,
  list: ReadonlySet<string> = EMPTY_SET,
  bool: ReadonlySet<string> = EMPTY_SET,
): FlagTokens {
  const sets: FlagSets = {
    known: new Set([...single, ...list, ...bool]),
    list,
    bool,
    usage,
  };
  const acc: FlagAcc = {
    positional: [],
    single: new Map(),
    list: new Map(),
    bools: new Set(),
  };
  for (let i = 0; i < args.length; i++) {
    i = consumeFlagToken(args, i, sets, acc);
  }
  return {
    positional: acc.positional,
    single: acc.single,
    list: acc.list,
    bools: acc.bools,
  };
}

/** A non-negative (decimal-allowed) price/duration arg. */
function parseNonNegNumber(raw: string, name: string): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return n;
}

export function parseFlightSearchArgs(args: string[]): CreateFlightSearchBody {
  const { positional, single } = tokenizeFlagSets(
    args,
    SEARCH_USAGE,
    new Set([
      "--return",
      "--cabin",
      "--adults",
      "--children",
      "--infants",
      "--site",
      "--currency",
      "--locale",
    ]),
  );
  const [from, to, fromDate, ...extra] = positional;
  if (!from || !to || !fromDate) throw new Error(SEARCH_USAGE);
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}\n${SEARCH_USAGE}`);
  }
  const body: CreateFlightSearchBody = {
    from,
    to,
    fromDate: parseIsoDate(fromDate, "<fromDate>"),
  };
  const toDate = single.get("--return");
  if (toDate) body.toDate = parseIsoDate(toDate, "--return");
  const cabin = single.get("--cabin");
  if (cabin) {
    // `has` on a `ReadonlySet<FlightCabin>` is a type guard, so the assignment
    // below needs no cast — the check and the contract are one thing.
    if (!isFlightCabin(cabin)) {
      throw new Error(`--cabin must be one of ${[...CABINS].join(", ")}`);
    }
    body.cabin = cabin;
  }
  applyFlightPax(single, body);
  const site = single.get("--site");
  if (site) body.siteCode = site;
  const currency = single.get("--currency");
  if (currency) body.currency = currency;
  const locale = single.get("--locale");
  if (locale) body.locale = locale;
  return body;
}

/** Mirror the API's page/pageSize bounds (apps/api flights/schema.ts
 *  DEFAULT_PAGE_SIZE/MAX_PAGE_SIZE) so this help text can't drift from what
 *  the server actually enforces (issue #1120). */
// Mirrors the API's 7-digit bound on the layover params.
const MAX_STOPOVER_DURATION = 9_999_999;

const FLIGHTS_MAX_PAGE = 100;
const FLIGHTS_DEFAULT_PAGE_SIZE = 10;
const FLIGHTS_MAX_PAGE_SIZE = 50;

/** The numeric single-valued results flags → typed query fields. */
function resultsNumericFlags(single: Map<string, string>): FlightResultsQuery {
  const q: FlightResultsQuery = {};
  const page = single.get("--page");
  if (page !== undefined)
    q.page = parseIntArg(page, "--page", FLIGHTS_MAX_PAGE);
  const pageSize = single.get("--page-size");
  if (pageSize !== undefined) {
    q.pageSize = parseIntArg(pageSize, "--page-size", FLIGHTS_MAX_PAGE_SIZE);
  }
  const minPrice = single.get("--min-price");
  if (minPrice !== undefined)
    q.minPrice = parseNonNegNumber(minPrice, "--min-price");
  const maxPrice = single.get("--max-price");
  if (maxPrice !== undefined)
    q.maxPrice = parseNonNegNumber(maxPrice, "--max-price");
  const maxDuration = single.get("--max-duration");
  if (maxDuration !== undefined) {
    q.maxDuration = parseNonNegNumber(maxDuration, "--max-duration");
  }
  const minStopover = single.get("--min-stopover-duration");
  if (minStopover !== undefined) {
    q.minStopoverDuration = parseIntArg(
      minStopover,
      "--min-stopover-duration",
      MAX_STOPOVER_DURATION,
      0,
    );
  }
  const maxStopover = single.get("--max-stopover-duration");
  if (maxStopover !== undefined) {
    q.maxStopoverDuration = parseIntArg(
      maxStopover,
      "--max-stopover-duration",
      MAX_STOPOVER_DURATION,
      0,
    );
  }
  // Per-leg duration bounds. Always leg-prefixed: the unprefixed
  // `--max-duration` above bounds the WHOLE trip, so an implicit-outbound
  // `--min-duration` beside it would read as the trip's floor.
  for (const [flag, field] of [
    ["--outbound-min-duration", "outboundMinDuration"],
    ["--outbound-max-duration", "outboundMaxDuration"],
    ["--return-min-duration", "returnMinDuration"],
    ["--return-max-duration", "returnMaxDuration"],
  ] as const) {
    const value = single.get(flag);
    if (value !== undefined) {
      q[field] = parseIntArg(value, flag, MAX_STOPOVER_DURATION, 0);
    }
  }
  return q;
}

/** A single-valued flag validated against a closed set (empty reads as absent). */
function enumFlag(
  single: Map<string, string>,
  flag: string,
  allowed: Set<string>,
): string | undefined {
  const value = single.get(flag);
  return value ? validateEnumValue(value, allowed, flag) : undefined;
}

/** The list-valued results flags → typed query fields (empty lists ignored). */
function resultsListFlags(list: Map<string, string[]>): FlightResultsQuery {
  const q: FlightResultsQuery = {};
  const airlines = list.get("--airlines");
  if (airlines?.length) q.airlines = airlines;
  const stops = list.get("--stops");
  if (stops?.length) q.stops = stops;
  const bookingSites = list.get("--booking-sites");
  if (bookingSites?.length) q.bookingSites = bookingSites;
  // The four leg/clock block flags, validated by one loop so a new one cannot
  // pick up looser checking than the flag beside it.
  for (const [flag, field] of [
    ["--departure-blocks", "departureBlocks"],
    ["--arrival-blocks", "arrivalBlocks"],
    ["--return-departure-blocks", "returnDepartureBlocks"],
    ["--return-arrival-blocks", "returnArrivalBlocks"],
  ] as const) {
    const values = list.get(flag);
    if (values?.length) {
      q[field] = validateEnumList(values, FLIGHT_DEPARTURE_BLOCKS, flag);
    }
  }
  // Open set upstream, so not validated locally; read metadata.filterOptions.
  const alliances = list.get("--alliances");
  if (alliances?.length) q.alliances = alliances;
  const bookingTypes = list.get("--booking-types");
  if (bookingTypes?.length) {
    q.bookingTypes = validateEnumList(
      bookingTypes,
      FLIGHT_BOOKING_TYPES,
      "--booking-types",
    );
  }
  const stopoverAirports = list.get("--stopover-airports");
  if (stopoverAirports?.length) q.stopoverAirports = stopoverAirports;
  const aircraft = list.get("--aircraft");
  if (aircraft?.length) q.aircraft = aircraft;
  return q;
}

export function parseFlightResultsArgs(args: string[]): {
  searchId: string;
  query: FlightResultsQuery;
  wait: boolean;
} {
  const { positional, single, list, bools } = tokenizeFlagSets(
    args,
    RESULTS_USAGE,
    new Set([
      "--page",
      "--page-size",
      "--sort",
      "--min-price",
      "--max-price",
      "--max-duration",
      "--min-stopover-duration",
      "--max-stopover-duration",
      "--departure-range",
      "--arrival-range",
      "--return-departure-range",
      "--return-arrival-range",
      "--outbound-min-duration",
      "--outbound-max-duration",
      "--return-min-duration",
      "--return-max-duration",
      "--currency",
      "--locale",
      "--airlines-match",
      "--same-airline",
    ]),
    new Set([
      "--airlines",
      "--stops",
      "--booking-sites",
      "--departure-blocks",
      "--arrival-blocks",
      "--return-departure-blocks",
      "--return-arrival-blocks",
      "--alliances",
      "--booking-types",
      "--stopover-airports",
      "--aircraft",
    ]),
    new Set(["--wait"]),
  );
  const [searchId, ...extra] = positional;
  if (!searchId) throw new Error(RESULTS_USAGE);
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}\n${RESULTS_USAGE}`);
  }
  const query: FlightResultsQuery = {
    ...resultsNumericFlags(single),
    ...resultsListFlags(list),
  };
  query.sort = enumFlag(single, "--sort", FLIGHT_SORTS);
  query.airlinesMatch = enumFlag(
    single,
    "--airlines-match",
    FLIGHT_AIRLINES_MATCHES,
  );
  query.sameAirline = enumFlag(single, "--same-airline", BOOL_FLAG_VALUES);
  // The four leg/clock window flags, all the same `min-max` minute-of-day shape.
  for (const [flag, field] of [
    ["--departure-range", "departureRange"],
    ["--arrival-range", "arrivalRange"],
    ["--return-departure-range", "returnDepartureRange"],
    ["--return-arrival-range", "returnArrivalRange"],
  ] as const) {
    const value = single.get(flag);
    if (value) query[field] = validateDepartureRange(value, flag);
  }
  // Only `all` adds a constraint; `any` is the server default and is inert alone.
  if (query.airlinesMatch === "all" && !query.airlines?.length) {
    throw new Error("--airlines-match all requires --airlines");
  }
  const currency = single.get("--currency");
  if (currency) query.currency = currency;
  const locale = single.get("--locale");
  if (locale) query.locale = locale;
  return { searchId, query, wait: bools.has("--wait") };
}

export function parseFlightTripArgs(args: string[]): {
  tripId: string;
  searchId: string;
  currency?: string;
  locale?: string;
  view?: string;
} {
  const { positional, single } = tokenizeFlagSets(
    args,
    TRIP_USAGE,
    new Set(["--search", "--currency", "--locale", "--view"]),
  );
  const [tripId, ...extra] = positional;
  if (!tripId) throw new Error(TRIP_USAGE);
  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}\n${TRIP_USAGE}`);
  }
  const searchId = single.get("--search");
  if (!searchId) {
    throw new Error(`--search <searchId> is required\n${TRIP_USAGE}`);
  }
  const out: {
    tripId: string;
    searchId: string;
    currency?: string;
    locale?: string;
    view?: string;
  } = {
    tripId,
    searchId,
  };
  const currency = single.get("--currency");
  if (currency) out.currency = currency;
  const locale = single.get("--locale");
  if (locale) out.locale = locale;
  // Guarded locally against the published enum, exactly as `hotels details` guards
  // the same axis: a typo exits 2 with the legal values named, rather than costing
  // a round trip to read a 400 back.
  const view = single.get("--view");
  if (view) out.view = validateEnumValue(view, DETAIL_VIEWS, "--view");
  return out;
}

/** Pretty-print a command's result as JSON (consistent output across commands). */
function printJson(value: unknown, deps: CommandIo): number {
  deps.log(JSON.stringify(value, null, 2));
  return 0;
}

function tokenSetToStored(tokens: TokenSet): StoredCredentials {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    market: tokens.market,
    idToken: tokens.idToken,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether `apiBaseUrl` points at a machine-local `apps/api` — so a connection
 * failure warrants the "is the local api running?" hint rather than a
 * network/URL hint. Covers `localhost`, the loopback IPs, and `*.localhost`
 * (the portless dev subdomains). A malformed URL is treated as non-local
 * (nothing to lose — it just omits the local-only hint).
 */
function isLoopbackHost(apiBaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(apiBaseUrl).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    // `URL.hostname` brackets IPv6, so the bare form never appears here.
    host === "[::1]"
  );
}

/**
 * Turn an error from an authed API call into an actionable one-line message.
 * Two cases get a concrete next step instead of a raw error:
 *
 * - **Unreachable** (`ApiUnreachableError`): name the host, and when it's a
 *   local target add the `bun dev` hint — the #1 first-run stumble is calling
 *   the CLI before `apps/api` is up (its default target is `localhost:3001`).
 * - **Rejected (401)** (`UnauthorizedError`): the server answered but refused
 *   the credential. After a login that just succeeded, "run login again" is
 *   misleading — the usual cause is a token issued for a *different*
 *   environment than `WEGO_API_URL` (e.g. staging token vs prod API), so say
 *   that before suggesting a re-login.
 *
 * Anything else (typed `ApiHttpError`, timeout, …) is delegated to
 * `formatCliError`, so it keeps the taxonomy's enrichment (code · detail ·
 * `trace_id` · Retry-After · next action). The stable exit *class* for any of
 * these is owned separately by `exitCodeForError`.
 */
function describeApiError(err: unknown, apiBaseUrl: string): string {
  if (err instanceof ApiUnreachableError) {
    const hint = isLoopbackHost(apiBaseUrl)
      ? ` Is the local \`apps/api\` running? Start it with \`bun dev\`, or point WEGO_API_URL at a deployed host.`
      : " Check WEGO_API_URL and your network connection.";
    return `Cannot reach the Wego API at ${apiBaseUrl}.${hint}`;
  }
  if (err instanceof UnauthorizedError) {
    return `The Wego API at ${apiBaseUrl} rejected your credentials (401). Your session may have expired, or your token was issued for a different environment than WEGO_API_URL – check WEGO_API_URL, then run \`${programName()} login\`.`;
  }
  return formatCliError(err, programName());
}

const OCCUPANCY: FlagLine[] = [
  ["--adults N", "Default 2."],
  ["--children N", ""],
  ["--infants N", ""],
];
const MONEY: FlagLine[] = [
  ["--site SG", "Market, 2-letter code."],
  ["--currency USD", ""],
  ["--locale en", ""],
];
const HOTEL_OCCUPANCY: FlagLine[] = [
  ["--adults N", "Default 2."],
  ["--children N", ""],
  ["--children-ages 5,11", "One age per child, 0 to 17."],
  ["--rooms N", "1 to 4, never more than adults."],
];

export const LOGIN_USAGE = usage({
  cmd: "login",
  what: "Log in with your Wego account. Opens a browser.",
  flags: [
    [
      "--no-browser",
      "Print the URL, then paste the redirect URL back here. Default over SSH.",
    ],
    ["--browser", "Open a browser here even over SSH."],
  ],
  env: [["WEGO_CLI_REDIRECT_PORT", "Fixed local port for the login callback."]],
});

export const WHOAMI_USAGE = usage({
  cmd: "whoami",
  what: "Show who is logged in.",
});

export const LOGOUT_USAGE = usage({
  cmd: "logout",
  what: "Remove the stored login.",
});

export const VERSION_USAGE = usage({
  cmd: "version",
  what: "Show the version.",
});

export const PLACES_USAGE = usage({
  cmd: 'places "<query>"',
  what: "Find a city, airport or hotel by name.",
  flags: [
    ["--types city,airport", "Comma-list.", NEARBY_TYPES],
    ["--locale en", ""],
    ["--page N", ""],
    ["--page-size N", `Max ${MAX_PAGE_SIZE}.`],
  ],
});

export const FEEDBACK_USAGE = usage({
  cmd: "feedback",
  what: "Send feedback to Wego. Give a rating, a message, or both.",
  flags: [
    ["--rating N", "1 to 5."],
    ["--category VALUE", "", FEEDBACK_CATEGORIES],
    ['--message "..."', "Up to 2000 characters."],
  ],
});

export const INFO_USAGE = group(
  "info",
  "Reference lookups. No search needed.",
  [
    ["holidays", "Public holidays for a country."],
    ["visa-free", "Countries a passport can enter without a visa."],
    ["schedules", "Nonstop scheduled flights on a route."],
    ["airports-near", "Airports and cities near a place."],
  ],
);

export const HOLIDAYS_USAGE = usage({
  cmd: "info holidays <country>",
  what: "Public holidays for a country. Next 90 days when no dates are given.",
  flags: [
    ["--from YYYY-MM-DD", "Start date. Needs --to."],
    ["--to YYYY-MM-DD", "End date. Needs --from."],
    ["--locale en", ""],
  ],
  see: "info",
});

export const VISA_FREE_USAGE = usage({
  cmd: "info visa-free <passportCountry>",
  what: "Countries a passport can enter without a visa. Whole list by default.",
  flags: [
    ["--locale en", ""],
    ["--page N", ""],
    ["--page-size N", `Max ${MAX_VISA_FREE_PAGE_SIZE}.`],
  ],
  see: "info",
});

export const SCHEDULES_USAGE = usage({
  cmd: "info schedules <from> <to>",
  what: "Nonstop scheduled flights on a route. City or airport codes.",
  flags: [
    ["--airline SQ", "One airline code."],
    ["--site SG", "Market, 2-letter code."],
    ["--locale en", ""],
    ["--page N", ""],
    ["--page-size N", `Max ${MAX_SCHEDULES_PAGE_SIZE}.`],
  ],
  see: "info",
});

export const AIRPORTS_NEAR_USAGE = usage({
  cmd: "info airports-near <place|lat,lng>",
  what: "Airports and cities near a place.",
  flags: [
    ["--types airport,city", "Comma-list.", NEARBY_TYPES],
    ["--locale en", ""],
    ["--page-size N", `Max ${MAX_PAGE_SIZE}.`],
  ],
  see: "info",
});

export const TARGET_USAGE = usage({
  cmd: "info target",
  what: "Which backend this binary talks to, and why. No network call.",
  flags: [["--json", "JSON only. Drops the readable table on stderr."]],
});

export const FLIGHTS_USAGE = group(
  "flights",
  "Search flights, open a trip, get a booking link.",
  [
    ["search", "Start a search. Returns a searchId."],
    ["results", "Read results of a search. Filter and sort."],
    ["trip", "Open one trip from the results."],
    ["experience", "Comfort signals per leg for one trip."],
    ["fares", "Fare options for one fare."],
    ["booking-link", "Checkout link for one fare. Expires with its search."],
    ["share", "A wego.com link for a search. Does not expire."],
  ],
);

export const SEARCH_USAGE = usage({
  cmd: "flights search <from> <to> <fromDate>",
  what: "Start a flight search and print the first page. Returns a searchId.",
  flags: [
    ["--return YYYY-MM-DD", "Return date."],
    ["--cabin VALUE", "Default economy.", CABINS],
    ...OCCUPANCY,
    ...MONEY,
  ],
  see: "flights",
});

export const RESULTS_USAGE = usage({
  cmd: "flights results <searchId>",
  what: "Read results of a search. Add --wait to block until the search settles.",
  flags: [
    ["--wait", "Wait for the search to settle."],
    ["--page N", ""],
    [
      "--page-size N",
      `Default ${FLIGHTS_DEFAULT_PAGE_SIZE}, max ${FLIGHTS_MAX_PAGE_SIZE}.`,
    ],
    ["--sort VALUE", "Default score_desc.", FLIGHT_SORTS],
    ["--airlines SQ,TR", "Any listed airline on any leg. Comma-list."],
    [
      "--airlines-match VALUE",
      "all: every leg has a listed airline. Needs --airlines.",
      FLIGHT_AIRLINES_MATCHES,
    ],
    ["--same-airline true", "One airline for the whole trip."],
    ["--alliances star_alliance", "Alliance codes, lowercase. Comma-list."],
    ["--stops 0,1", "Exact stop counts. At most 1 is 0,1."],
    ["--min-price N", "Whole trip."],
    ["--max-price N", "Whole trip."],
    ["--max-duration N", "Whole trip, minutes."],
    ["--outbound-min-duration N", "Outbound leg, minutes."],
    ["--outbound-max-duration N", "Outbound leg, minutes."],
    ["--return-min-duration N", "Return leg, minutes."],
    ["--return-max-duration N", "Return leg, minutes."],
    ["--min-stopover-duration N", "Longest layover, minutes."],
    ["--max-stopover-duration N", "Longest layover, minutes."],
    [
      "--departure-blocks morning",
      "Outbound departure. 6-hour blocks, no overlap. Comma-list.",
      FLIGHT_DEPARTURE_BLOCKS,
    ],
    ["--arrival-blocks night", "Outbound arrival. Same values."],
    ["--return-departure-blocks morning", "Return departure. Same values."],
    ["--return-arrival-blocks night", "Return arrival. Same values."],
    [
      "--departure-range 1320-360",
      "Outbound departure, minutes of day 0-1439. Start after end wraps midnight.",
    ],
    ["--arrival-range 0-1080", "Outbound arrival, local clock."],
    ["--return-departure-range 360-720", "Return departure."],
    ["--return-arrival-range 0-1320", "Return arrival, local clock."],
    ["--stopover-airports DOH", "Layover airports. Comma-list."],
    ["--aircraft 380,789", "Aircraft type codes, not names. Comma-list."],
    ["--booking-types VALUE", "Comma-list.", FLIGHT_BOOKING_TYPES],
    ["--booking-sites expedia.com", "Booking site domains. Comma-list."],
    ["--currency USD", ""],
    ["--locale en", ""],
  ],
  note: "Return flags match nothing on a one-way search.",
  see: "flights",
});

export const TRIP_USAGE = usage({
  cmd: "flights trip <tripId> --search <searchId>",
  what: "Open one trip from a search.",
  flags: [
    ["--search ID", "Required. The searchId the trip came from."],
    ["--view VALUE", "detail lists every segment.", DETAIL_VIEWS],
    ["--currency USD", ""],
    ["--locale en", ""],
  ],
  see: "flights",
});

export const EXPERIENCE_USAGE = usage({
  cmd: "flights experience <tripId>",
  what: "Comfort signals per leg: overnight, long stopover, early departure, late arrival.",
  flags: [["--search ID", "The searchId, as a cross-check."]],
  note: "An absent signal means unknown, not false.",
  see: "flights",
});

export const FARES_USAGE = usage({
  cmd: "flights fares <fareId>",
  what: "Fare options for a Book on Wego fare, by leg then price.",
  flags: [
    ["--currency USD", ""],
    ["--locale en", ""],
  ],
  see: "flights",
});

export const BOOKING_LINK_USAGE = usage({
  cmd: "flights booking-link <fareId> --trip ID --fare-option ID",
  what: "Checkout link for a fare. Expires with its search.",
  flags: [
    ["--trip ID", "Required. The tripId the fare belongs to."],
    [
      "--fare-option ID",
      `Required. From ${PROG} flights fares. Repeat for one per leg when a fare covers one leg.`,
    ],
    ["--from SIN", "Required."],
    ["--to BKK", "Required."],
    ["--date YYYY-MM-DD", "Required. Departure date."],
    ["--return YYYY-MM-DD", "Return date."],
    ["--search ID", "The searchId, as a cross-check."],
    ["--cabin VALUE", "", CABINS],
    ...OCCUPANCY,
    ...MONEY,
    ["--from-city", "Read --from as a city, not an airport."],
    ["--to-city", "Read --to as a city, not an airport."],
  ],
  see: "flights",
});

export const SHARE_USAGE = usage({
  cmd: "flights share <from> <to> <fromDate>",
  what: "A wego.com search link to send to someone. Does not expire. Shows live prices.",
  flags: [
    ["--return YYYY-MM-DD", "Return date."],
    ["--cabin VALUE", "", CABINS],
    ...OCCUPANCY,
    ...MONEY,
    ["--from-city", "Read <from> as a city, not an airport."],
    ["--to-city", "Read <to> as a city, not an airport."],
  ],
  see: "flights",
});

export const HOTELS_USAGE = group(
  "hotels",
  "Search hotels, open one, list rooms, get a booking link.",
  [
    ["search", "Start a search. Returns a searchId."],
    ["results", "Read results of a search. Filter and sort."],
    ["details", "One hotel: description, amenities, images."],
    ["reviews", "Guest reviews for one hotel."],
    ["rooms", "Rooms and rates for one hotel."],
    ["booking-link", "Checkout link for one rate. Expires with its search."],
    ["share", "A wego.com link for a search. Does not expire."],
  ],
);

export const HOTELS_SEARCH_USAGE = usage({
  cmd: "hotels search <cityCode|hotelId|lat,lng> <checkIn> <checkOut>",
  what: "Start a hotel search and print the first page. Returns a searchId.",
  flags: [
    ...HOTEL_OCCUPANCY,
    ["--radius KM", "Around lat,lng only."],
    ...MONEY,
  ],
  see: "hotels",
});

export const HOTELS_RESULTS_USAGE = usage({
  cmd: "hotels results <searchId>",
  what: "Read results of a search. Add --wait to block until the search settles.",
  flags: [
    ["--wait", "Wait for the search to settle."],
    ["--page N", ""],
    ["--page-size N", `Max ${MAX_PAGE_SIZE}.`],
    [
      "--sort VALUE",
      "Default relevance. guest_rating_desc needs --guest-type.",
      HOTEL_SORTS,
    ],
    ["--min-star N", "Stars, 1 to 5."],
    ["--max-star N", "Stars, 1 to 5."],
    ["--min-review-score N", "All-guest review score, 0 to 10."],
    [
      "--guest-type VALUE",
      "Judge by this guest group. Use with --min-guest-rating or --sort guest_rating_desc.",
      HOTEL_GUEST_TYPES,
    ],
    ["--min-guest-rating N", "0 to 10, for the --guest-type group."],
    ["--min-price N", "Per stay."],
    ["--max-price N", "Per stay."],
    ["--refundable true", "Only hotels with a confirmed refundable rate."],
    ["--deals-only true", "Only hotels with a deal."],
    [
      "--rate-types breakfast_included",
      "Rate codes, exact match. Comma-list means one rate with all of them.",
    ],
    ["--amenities pool", "Name match. Comma-list."],
    ["--property-types hotel", "Name match. Comma-list."],
    ["--brands marriott", "Name match. Comma-list."],
    ["--chains accor", "Name match. Comma-list."],
    ["--districts deira", "Name match. Comma-list."],
    ["--currency USD", ""],
    ["--locale en", ""],
  ],
  note: "Filter names and codes for this search are in metadata.filterOptions.",
  see: "hotels",
});

export const HOTELS_DETAILS_USAGE = usage({
  cmd: "hotels details <hotelId>",
  what: "One hotel: description, amenities, images.",
  flags: [
    ["--view VALUE", "", DETAIL_VIEWS],
    ["--locale en", ""],
  ],
  see: "hotels",
});

export const HOTELS_REVIEWS_USAGE = usage({
  cmd: "hotels reviews <hotelId>",
  what: "Guest reviews, newest first. Pros and cons already split.",
  flags: [
    ["--topics breakfast,pool", "Any listed topic. Comma-list."],
    ["--guest-type VALUE", "", REVIEW_GUEST_TYPES],
    ["--sort VALUE", "Default posted_at_desc.", REVIEW_SORTS],
    ["--page N", ""],
    ["--page-size N", `Max ${MAX_PAGE_SIZE}.`],
    [
      "--view VALUE",
      "detail adds review text and reviewer country.",
      DETAIL_VIEWS,
    ],
    ["--locale en", ""],
  ],
  see: "hotels",
});

export const HOTELS_ROOMS_USAGE = usage({
  cmd: "hotels rooms <hotelId> <checkIn> <checkOut>",
  alt: ["hotels rooms <hotelId> --search <searchId>"],
  what: "Rooms and rates for one hotel, cheapest first.",
  flags: [
    [
      "--search ID",
      "Re-read a rooms search. Takes no other flags but --currency and --locale.",
    ],
    ["--check-in YYYY-MM-DD", "Same as the <checkIn> argument."],
    ["--check-out YYYY-MM-DD", "Same as the <checkOut> argument."],
    ...HOTEL_OCCUPANCY,
    ...MONEY,
  ],
  see: "hotels",
});

export const HOTELS_BOOKING_LINK_USAGE = usage({
  cmd: "hotels booking-link <hotelId> --rate <rateId>",
  what: "Checkout link for a room rate. Expires with its search.",
  flags: [
    ["--rate ID", `Required. From ${PROG} hotels rooms.`],
    ["--search ID", "The searchId the rate came from."],
    ["--site SG", "Market, 2-letter code."],
    ["--country AE", "Country code, copied into the link."],
    ["--locale en", ""],
  ],
  see: "hotels",
});

export const HOTELS_SHARE_USAGE = usage({
  cmd: "hotels share <cityCode> <checkIn> <checkOut>",
  what: "A wego.com hotel search link to send to someone. Does not expire. City only.",
  flags: [...HOTEL_OCCUPANCY, ...MONEY],
  see: "hotels",
});
