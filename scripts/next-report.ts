/**
 * Read the reports wego-ai writes onto a release commit, `cli-next-smoke` and
 * `cli-next-evals`, and show them to whoever is about to promote.
 *
 *   bun run scripts/next-report.ts            # release-cli.yml, after notify-verify
 *   bun run scripts/next-report.ts --banner   # promote-cli.yml, one look, one line
 *
 * WHAT IS BEING READ. Once `cli/next` moves, `notify-verify` asks a receiver in
 * wego-ai to smoke the new build against staging, then evaluate its skill.
 * wego-ai writes each answer back as a check run on this repository, at the
 * tag's commit, as its GitHub App (id 4987365): `cli-next-smoke` in minutes,
 * `cli-next-evals` in up to hours. Each check's `output.text` carries ONE fenced
 * ```json block, in `cli-next-smoke/v1` or `cli-next-evals/v1`; the payloads in
 * `scripts/next-report/payloads/` are the shared fixtures for that interface and
 * are byte-identical to the ones wego-ai tests its writer against.
 *
 * ONLY THAT APP'S CHECK COUNTS. Any App with `checks: write` on this repository
 * can create a check run with either name, and a report that said "ready"
 * would be read by a person deciding whether to move `cli/stable`. So the name is
 * a filter and the App id is the proof: a check from any other App is ignored as
 * if it did not exist.
 *
 * IT NEVER FAILS A RUN. The report is advice for a human, and both lanes that run
 * this have already done their real work (the release published, the promote
 * gates run on their own). Every state, including "could not read anything",
 * becomes a line in the step summary and exit 0. The workflow steps wrap this
 * script again so that a crash is a summary line too.
 *
 * Everything that decides what the reader sees is a pure function below; `run`
 * wires them to `fetch` and a clock, both injectable, and the `import.meta.main`
 * block is only process I/O.
 */

/** The check run's name, fixed by the cross-repository interface. */
export const CHECK_NAME = "cli-next-smoke";

/** wego-ai's GitHub App. A check run from any other App is not the report. */
export const REPORT_APP_ID = 4987365;

/** The one schema this reader understands. Anything else is "could not read". */
export const SCHEMA = "cli-next-smoke/v1";

/**
 * The evals are their own check run: the smoke answers "does the binary work"
 * in minutes, the evals answer "how well does its skill do" in up to hours. The
 * release run waits for the smoke only; the evals are read where the promote
 * decision is made.
 */
export const EVALS_CHECK_NAME = "cli-next-evals";
export const EVALS_SCHEMA = "cli-next-evals/v1";

const EVALS_VERDICTS = ["ready", "look_first", "not_run"] as const;
export type EvalsVerdict = (typeof EVALS_VERDICTS)[number];

/** One eval set: the frozen regression set or the persona subset. */
export interface EvalSet {
  id: string;
  result: string;
  /** Why a set was not run, e.g. no change to the skill since the baseline. */
  reason?: string;
  /** The version this set's scores are compared with. */
  baseline?: string;
}

export interface EvalsReport {
  schema: typeof EVALS_SCHEMA;
  version: string;
  sha: string;
  previous?: string;
  verdict: EvalsVerdict;
  headline: string;
  sets: EvalSet[];
  run_url?: string;
}

const EVALS_BANNERS: Record<EvalsVerdict, string> = {
  ready: "✓ Ready",
  look_first: "⚠ Look first",
  not_run: "● Skipped",
};

const VERDICTS = [
  "ready",
  "look_first",
  "staging_problem",
  "binary_problem",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Part {
  id: string;
  result: string;
  value?: string | number;
  detail?: string;
  previous?: string | number;
}

export interface Report {
  schema: typeof SCHEMA;
  version: string;
  sha: string;
  previous?: string;
  verdict: Verdict;
  headline: string;
  parts: Part[];
  run_url?: string;
}

/** The fields of a GitHub check run this script reads. */
export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: string | null;
  details_url?: string | null;
  html_url?: string | null;
  app?: { id?: number } | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  } | null;
}

/** What the reader sees: markdown for the step summary, workflow commands for the log. */
export interface Outcome {
  summary: string;
  annotations: string[];
}

/** The polling budget. Injectable so the tests do not wait 45 minutes. */
export interface Limits {
  /** Between two looks. */
  intervalMs: number;
  /** No matching check by then: wego-ai did not start. */
  startMs: number;
  /** A check exists but is not completed by then: stop waiting. */
  totalMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  intervalMs: 30_000,
  startMs: 10 * 60_000,
  totalMs: 45 * 60_000,
};

const BANNERS: Record<Verdict, string> = {
  ready: "✓ Ready",
  look_first: "⚠ Look first",
  staging_problem: "✗ Staging problem",
  binary_problem: "✗ Binary problem",
};

const LABELS: Record<string, string> = {
  binary: "Binary is the tag",
  stable: "Stable commands",
  errors: "Error responses",
  search: "Search round trips",
  startup_ms: "Startup",
  evals: "Skill evals",
};

const EVALS: Record<string, string> = {
  ok: "ok",
  below: "below",
  not_run: "not run",
  not_configured: "not configured",
};

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const FENCE = /```json[^\S\n]*\n([\s\S]*?)```/g;

/**
 * A workflow command's message, escaped the way the runner unescapes it. The
 * headline is another repository's text; without this a newline in it would end
 * the annotation early and start whatever followed as a new line of the log.
 */
export function commandMessage(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** A table cell: one line, and no `|` to split the row. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * The report inside a check run's `output.text`, or the reason there is none.
 *
 * Exactly one ```json fence. Zero means the writer did not attach one; two means
 * this reader would be guessing which is the report, and a guess is exactly what
 * a person deciding a promote should not be shown.
 */
export function parseReport(
  text: string | null | undefined,
): { report: Report } | { error: string } {
  const fences = [...(text ?? "").matchAll(FENCE)];
  if (fences.length !== 1) {
    return {
      error:
        fences.length === 0
          ? "the check carries no ```json block"
          : `the check carries ${fences.length} \`\`\`json blocks, not one`,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(fences[0]?.[1] ?? "");
  } catch {
    return { error: "the ```json block is not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { error: "the ```json block is not an object" };
  }
  const r = data as Record<string, unknown>;
  if (r.schema !== SCHEMA) {
    return {
      error: `the report's schema is ${JSON.stringify(r.schema ?? null)}, not ${SCHEMA}`,
    };
  }
  if (!VERDICTS.includes(r.verdict as Verdict)) {
    return {
      error: `the report's verdict ${JSON.stringify(r.verdict ?? null)} is not one this reader knows`,
    };
  }
  if (typeof r.headline !== "string" || typeof r.version !== "string") {
    return { error: "the report has no headline or no version" };
  }
  if (typeof r.sha !== "string") {
    return { error: "the report names no commit" };
  }
  if (r.previous !== undefined && typeof r.previous !== "string") {
    return { error: "the report's previous version is not a string" };
  }
  const parts = r.parts;
  if (
    !Array.isArray(parts) ||
    !parts.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Part).id === "string" &&
        typeof (p as Part).result === "string",
    )
  ) {
    return { error: "the report's parts are not a list of {id, result}" };
  }
  return { report: r as unknown as Report };
}

/**
 * The report among a commit's check runs: named `cli-next-smoke` AND written by
 * wego-ai's App. The newest wins, because a re-run of wego-ai's lane writes a
 * fresh check run rather than editing the old one.
 */
export function pickCheck(
  runs: CheckRun[],
  name: string = CHECK_NAME,
): CheckRun | undefined {
  return runs
    .filter((r) => r.name === name && r.app?.id === REPORT_APP_ID)
    .sort(
      (a, b) =>
        Date.parse(b.started_at ?? "") - Date.parse(a.started_at ?? "") ||
        b.id - a.id,
    )[0];
}

function heading(tag: string): string {
  return `### next report · ${tag}`;
}

function detailsLine(check: CheckRun, report?: Report): string {
  const url = check.details_url || check.html_url || report?.run_url;
  return url
    ? `Details: [private wego-ai run (org members)](${url})`
    : "Details: the check carries no link to its run";
}

/** A step's value in one column: the part's own value or detail, or the previous one. */
function stepCell(part: Part, which: "current" | "previous"): string {
  if (which === "previous") {
    return part.previous === undefined ? "–" : cell(String(part.previous));
  }
  const shown = part.value ?? part.detail;
  const text = shown === undefined ? "" : ` ${cell(String(shown))}`;
  switch (part.result) {
    case "pass":
      return `✓${text}`;
    case "fail":
      return `✗${text}`;
    case "noted":
      return `noted${text}`;
    default:
      return cell(`${part.result}${text}`);
  }
}

function partCells(part: Part): [string, string] {
  if (part.id === "startup_ms") {
    const ms = (v: string | number | undefined) =>
      v === undefined ? "–" : cell(`${v} ms`);
    return [ms(part.previous), ms(part.value)];
  }
  if (part.id === "evals") {
    return [
      part.previous === undefined
        ? "–"
        : cell(EVALS[String(part.previous)] ?? String(part.previous)),
      cell(EVALS[part.result] ?? part.result),
    ];
  }
  return [stepCell(part, "previous"), stepCell(part, "current")];
}

/** The table: one row per part, the previous release beside this one. */
export function renderTable(report: Report): string {
  const prev = report.previous ? `v${cell(report.previous)}` : "previous";
  const rows = report.parts.map((part) => {
    const [before, now] = partCells(part);
    return `| ${cell(LABELS[part.id] ?? part.id)} | ${before} | ${now} |`;
  });
  return [
    `| Part | ${prev} | v${cell(report.version)} |`,
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** The verdict's one line: the banner a promoter reads first. */
export function bannerLine(report: Report): string {
  return `${BANNERS[report.verdict]}: ${cell(report.headline)}`;
}

/**
 * A completed check, rendered. `table: false` is the promote banner: the same
 * verdict and link, without the rows the release run already showed.
 */
export function renderCompleted(
  tag: string,
  sha: string,
  check: CheckRun,
  opts: { table: boolean },
): Outcome {
  const parsed = parseReport(check.output?.text);
  let reason = "error" in parsed ? parsed.error : undefined;
  if ("report" in parsed && parsed.report.sha !== sha) {
    // A report about another commit is not a report about this one, however
    // well-formed. The check run sits on `sha`, so this is the writer
    // disagreeing with itself, and the reader should not pick a side.
    reason = `the report is for commit ${parsed.report.sha}, not ${sha}`;
  }
  if (reason !== undefined || !("report" in parsed)) {
    const title = check.output?.title?.trim() || "(the check has no title)";
    return {
      summary: [
        heading(tag),
        "",
        `● Report unreadable: ${cell(title)}`,
        "",
        detailsLine(check),
        "",
      ].join("\n"),
      annotations: [
        `::warning::${commandMessage(`next-report: the ${CHECK_NAME} report for ${tag} could not be read (${reason}). See the private report before promoting.`)}`,
      ],
    };
  }
  const report = parsed.report;
  const lines = [
    heading(tag),
    "",
    bannerLine(report),
    "",
    detailsLine(check, report),
    "",
  ];
  if (opts.table) lines.push(renderTable(report), "");
  const message = `next-report: ${report.headline}. See the private report before promoting.`;
  return {
    summary: lines.join("\n"),
    annotations: [
      `${report.verdict === "ready" ? "::notice::" : "::warning::"}${commandMessage(message)}`,
    ],
  };
}

/** The evals report inside its check run's `output.text`, or why there is none. */
export function parseEvals(
  text: string | null | undefined,
): { report: EvalsReport } | { error: string } {
  const fences = [...(text ?? "").matchAll(FENCE)];
  if (fences.length !== 1) {
    return {
      error: `the check carries ${fences.length} \`\`\`json blocks, not one`,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(fences[0]?.[1] ?? "");
  } catch {
    return { error: "the ```json block is not valid JSON" };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  if (r.schema !== EVALS_SCHEMA) {
    return {
      error: `the report's schema is ${JSON.stringify(r.schema ?? null)}, not ${EVALS_SCHEMA}`,
    };
  }
  if (!EVALS_VERDICTS.includes(r.verdict as EvalsVerdict)) {
    return {
      error: `the report's verdict ${JSON.stringify(r.verdict ?? null)} is not one this reader knows`,
    };
  }
  if (
    typeof r.headline !== "string" ||
    typeof r.version !== "string" ||
    typeof r.sha !== "string" ||
    !Array.isArray(r.sets)
  ) {
    return { error: "the report has no headline, version, commit or sets" };
  }
  return { report: r as unknown as EvalsReport };
}

/**
 * The evals in one line, for the release summary and the promote banner, plus
 * the annotation a "look first" deserves. A missing or running evals check is a
 * state, never an error: the evals may take hours, and the smoke already said
 * whether the binary works.
 */
export function evalsLine(
  sha: string,
  found: Lookup,
  now: number,
): { line: string; annotation?: string; pending?: boolean } {
  if ("error" in found) {
    return { line: `● Skill evals: could not be read (${cell(found.error)})` };
  }
  const check = found.check;
  if (!check) return { line: "● Skill evals: not started yet", pending: true };
  if (check.status !== "completed") {
    const started = Date.parse(check.started_at ?? "");
    const ago = Number.isNaN(started)
      ? "an unknown time"
      : `${Math.max(0, Math.floor((now - started) / 60_000))} min`;
    return {
      line: `● Skill evals: running, started ${ago} ago`,
      pending: true,
    };
  }
  const parsed = parseEvals(check.output?.text);
  const reason =
    "error" in parsed
      ? parsed.error
      : parsed.report.sha !== sha
        ? `the report is for commit ${parsed.report.sha}, not ${sha}`
        : undefined;
  if (reason !== undefined || !("report" in parsed)) {
    const title = check.output?.title?.trim() || "(the check has no title)";
    return {
      line: `● Skill evals: report unreadable: ${cell(title)}`,
      annotation: `::warning::${commandMessage(`next-report: the ${EVALS_CHECK_NAME} report could not be read (${reason}).`)}`,
    };
  }
  const report = parsed.report;
  return {
    line: `Skill evals: ${EVALS_BANNERS[report.verdict]}: ${cell(report.headline)}`,
    annotation:
      report.verdict === "look_first"
        ? `::warning::${commandMessage(`next-report: skill evals: ${report.headline}. See the private report before promoting.`)}`
        : undefined,
  };
}

/** Append the evals line (and its annotation) to an outcome. */
function withEvals(
  outcome: Outcome,
  evals: { line: string; annotation?: string },
): Outcome {
  return {
    summary: `${outcome.summary.trimEnd()}\n\n${evals.line}\n`,
    annotations:
      evals.annotation === undefined
        ? outcome.annotations
        : [...outcome.annotations, evals.annotation],
  };
}

/** A state with no report to show: one line, and the annotation that goes with it. */
export function renderNoReport(
  tag: string,
  line: string,
  annotation?: string,
): Outcome {
  return {
    summary: [heading(tag), "", line, ""].join("\n"),
    annotations: annotation === undefined ? [] : [annotation],
  };
}

/** The result of one look at the commit's check runs. */
export type Lookup = { check: CheckRun | undefined } | { error: string };

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** One progress line per look, for the job log. Silent when absent. */
  log?: (line: string) => void;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 6_000) / 10} min`;
}

/** What one look found, as the job log shows it while the wait goes on: the
 *  step summary only says anything once the wait is over. */
export function pollLine(
  found: Lookup,
  elapsedMs: number,
  firstSeen: boolean,
): string {
  const at = minutes(elapsedMs);
  if ("error" in found)
    return `${at}: could not read the check runs (${found.error})`;
  const check = found.check;
  if (!check) return `${at}: not started yet`;
  if (check.status === "completed") {
    return `${at}: completed: ${check.output?.title ?? check.conclusion ?? "no title"}`;
  }
  const link =
    firstSeen && check.details_url ? `: wego-ai run ${check.details_url}` : "";
  return `${at}: in progress${link}`;
}

/**
 * The release lane's wait, as a function of what `notify-verify` was answered.
 *
 * 404 and a refusal are known before any look: nothing was dispatched, so a
 * 45-minute wait for a check that cannot come would only cost runner time. 202
 * and 409 both mean wego-ai is running (409 is a replayed request whose first
 * attempt was accepted), so those wait.
 */
export async function watch(
  tag: string,
  sha: string,
  notifyStatus: string,
  lookup: () => Promise<Lookup>,
  clock: Clock,
  limits: Limits = DEFAULT_LIMITS,
  lookupEvals?: () => Promise<Lookup>,
): Promise<Outcome> {
  if (notifyStatus === "404") {
    return renderNoReport(tag, "● No report: the receiver is switched off");
  }
  if (notifyStatus !== "202" && notifyStatus !== "409") {
    return renderNoReport(
      tag,
      "● No report: the request to wego-ai was refused",
    );
  }
  const start = clock.now();
  let seen = false;
  let lastError: string | undefined;
  clock.log?.(
    `waiting for ${CHECK_NAME} on ${tag} (${sha.slice(0, 7)}), up to ${minutes(limits.totalMs)}, looking every ${Math.round(limits.intervalMs / 1000)} s`,
  );
  for (;;) {
    const found = await lookup();
    clock.log?.(
      pollLine(
        found,
        clock.now() - start,
        !seen && "check" in found && found.check !== undefined,
      ),
    );
    if ("error" in found) {
      lastError = found.error;
    } else {
      lastError = undefined;
      if (found.check) {
        seen = true;
        if (found.check.status === "completed") {
          const smoke = renderCompleted(tag, sha, found.check, { table: true });
          if (!lookupEvals) return smoke;
          // One look, never a wait: the evals can take hours, and the promote
          // banner reads them again when the decision is made.
          const evals = evalsLine(sha, await lookupEvals(), clock.now());
          return withEvals(
            smoke,
            evals.pending
              ? { line: `${evals.line}; the promote banner shows the result` }
              : evals,
          );
        }
      }
    }
    const elapsed = clock.now() - start;
    if (!seen && elapsed >= limits.startMs) {
      if (lastError !== undefined) {
        return renderNoReport(
          tag,
          "● No report: the check runs could not be read",
          `::warning::${commandMessage(`next-report: the check runs for ${tag} could not be read (${lastError}).`)}`,
        );
      }
      const minutes = Math.round(limits.startMs / 60_000);
      return renderNoReport(
        tag,
        "● No report: wego-ai did not start",
        `::warning::${commandMessage(`next-report: wego-ai wrote no ${CHECK_NAME} check for ${tag} within ${minutes} min, though the receiver accepted the request.`)}`,
      );
    }
    if (elapsed >= limits.totalMs) {
      const minutes = Math.round(limits.totalMs / 60_000);
      return renderNoReport(
        tag,
        `● No report yet: still running after ${minutes} min`,
        `::notice::${commandMessage(`next-report: the ${CHECK_NAME} check for ${tag} is still running. promote-cli.yml shows its verdict when it lands.`)}`,
      );
    }
    await clock.sleep(limits.intervalMs);
  }
}

/**
 * The promote lane's single look. No waiting: a promoter who dispatches while
 * the smoke is still running should see that, not sit behind it.
 */
export function banner(
  tag: string,
  sha: string,
  found: Lookup,
  now: number,
  evalsFound?: Lookup,
): Outcome {
  const smoke = smokeBanner(tag, sha, found, now);
  return evalsFound === undefined
    ? smoke
    : withEvals(smoke, evalsLine(sha, evalsFound, now));
}

function smokeBanner(
  tag: string,
  sha: string,
  found: Lookup,
  now: number,
): Outcome {
  if ("error" in found) {
    return renderNoReport(
      tag,
      "● No report: the check runs could not be read",
      `::warning::${commandMessage(`next-report: the check runs for ${tag} could not be read (${found.error}).`)}`,
    );
  }
  const check = found.check;
  if (!check) {
    return renderNoReport(
      tag,
      `● No report: wego-ai wrote no ${CHECK_NAME} check for this commit`,
    );
  }
  if (check.status !== "completed") {
    const started = Date.parse(check.started_at ?? "");
    const ago = Number.isNaN(started)
      ? "an unknown time"
      : `${Math.max(0, Math.floor((now - started) / 60_000))} min`;
    return {
      summary: [
        heading(tag),
        "",
        `● No report yet, started ${ago} ago`,
        "",
        detailsLine(check),
        "",
      ].join("\n"),
      annotations: [],
    };
  }
  return renderCompleted(tag, sha, check, { table: false });
}

export interface Env {
  GITHUB_REPOSITORY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_API_URL?: string;
  TAG?: string;
  SHA?: string;
  NOTIFY_STATUS?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function github(env: Env, fetcher: Fetch) {
  const base = (env.GITHUB_API_URL || "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
    "User-Agent": "wego-cli-next-report",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const get = async (path: string): Promise<unknown> => {
    const res = await fetcher(`${base}${path}`, { headers });
    if (!res.ok) throw new Error(`GET ${path} answered HTTP ${res.status}`);
    return res.json();
  };
  const repo = env.GITHUB_REPOSITORY ?? "";
  return {
    /** The commit a tag names, through the API rather than a full-history checkout. */
    async commitOf(ref: string): Promise<string> {
      const data = (await get(
        `/repos/${repo}/commits/${encodeURIComponent(ref)}`,
      )) as { sha?: unknown };
      if (typeof data.sha !== "string" || !FULL_SHA.test(data.sha)) {
        throw new Error(`${ref} resolved to no commit`);
      }
      return data.sha;
    },
    /**
     * One look. `app_id` narrows the page on the server; `pickCheck` is the
     * filter this relies on.
     */
    async lookup(sha: string, name: string = CHECK_NAME): Promise<Lookup> {
      try {
        const data = (await get(
          `/repos/${repo}/commits/${sha}/check-runs?check_name=${name}&app_id=${REPORT_APP_ID}&per_page=100`,
        )) as { check_runs?: CheckRun[] };
        return { check: pickCheck(data.check_runs ?? [], name) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}

/**
 * Both modes, end to end, over an injected `fetch` and clock. Throws only on a
 * bug; every expected state is an Outcome.
 */
export async function run(
  argv: string[],
  env: Env,
  fetcher: Fetch,
  clock: Clock,
  limits: Limits = DEFAULT_LIMITS,
): Promise<Outcome> {
  const tag = env.TAG ?? "";
  const shown = RELEASE_TAG.test(tag) ? tag : "(no tag)";
  if (!RELEASE_TAG.test(tag)) {
    return renderNoReport(
      shown,
      `● No report: ${JSON.stringify(tag)} is not a vX.Y.Z release tag`,
    );
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    return renderNoReport(
      tag,
      "● No report: GITHUB_REPOSITORY does not name a repository",
    );
  }
  const api = github(env, fetcher);

  if (argv.includes("--banner")) {
    let sha: string;
    try {
      sha = await api.commitOf(tag);
    } catch (err) {
      return renderNoReport(
        tag,
        "● No report: the tag's commit could not be read",
        `::warning::${commandMessage(`next-report: ${(err as Error).message}.`)}`,
      );
    }
    return banner(
      tag,
      sha,
      await api.lookup(sha),
      clock.now(),
      await api.lookup(sha, EVALS_CHECK_NAME),
    );
  }

  const sha = env.SHA ?? "";
  if (!FULL_SHA.test(sha)) {
    return renderNoReport(tag, "● No report: no commit to look up");
  }
  return watch(
    tag,
    sha,
    env.NOTIFY_STATUS ?? "",
    () => api.lookup(sha),
    clock,
    limits,
    () => api.lookup(sha, EVALS_CHECK_NAME),
  );
}

if (import.meta.main) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const emit = async (outcome: Outcome) => {
    for (const line of outcome.annotations) console.log(line);
    console.log(outcome.summary);
    if (summaryPath) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(summaryPath, `${outcome.summary}\n`);
    }
  };
  try {
    await emit(
      await run(process.argv.slice(2), process.env as Env, fetch, {
        now: () => Date.now(),
        sleep: (ms) => Bun.sleep(ms),
        log: (line) => console.log(line),
      }),
    );
  } catch (err) {
    // A bug here must not become a red run: the report is advice, and the lane
    // around it has already done its work.
    await emit(
      renderNoReport(
        process.env.TAG || "(no tag)",
        "● No report: next-report crashed",
        `::warning::${commandMessage(`next-report crashed: ${(err as Error)?.message ?? String(err)}`)}`,
      ),
    );
  }
  process.exit(0);
}
