#!/usr/bin/env bun
/**
 * Refresh the vendored API contract at `contract/openapi.json`.
 *
 * The CLI is a separate repository from the API, so there is no path it can
 * read the contract from at build time. It vendors one instead: this script
 * fetches the published document, writes it here, and the rest of the chain
 * (`api-types:generate`, Checks A and C, Check B) runs against the committed
 * copy. Refreshing is a deliberate act - run this, commit the JSON diff on its
 * own, then fix whatever the checks report.
 *
 * Always production. The document carries a `servers` block naming the host it
 * was served from, so a staging or preview URL would rewrite that line on every
 * refresh and make the diff unreadable, on top of vendoring a contract nothing
 * ships against.
 */

/** The published contract. Production, unauthenticated, never staging. */
const CONTRACT_URL = "https://api.wego.com/openapi";

const OUTPUT = new URL("../contract/openapi.json", import.meta.url);

/** Attempts in total, not retries after the first: the API is behind a CDN and
 *  a single 5xx or dropped connection is not worth a failed refresh. */
const ATTEMPTS = 4;

/** Between attempts. Short: this is a person waiting at a terminal. */
const RETRY_DELAY_MS = 1_000;

/** The minimum shape that makes a body a contract rather than an error page.
 *  A 200 carrying HTML from a misrouted edge would otherwise be committed. */
export interface ContractDocument {
  openapi: string;
  info: { version: string };
  paths: Record<string, unknown>;
}

/** Why this body is not a contract, or `undefined` when it is one. */
export function contractProblem(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "the body is not a JSON object";
  }
  const document = body as Partial<ContractDocument>;
  if (typeof document.openapi !== "string") {
    return "the body has no `openapi` version string";
  }
  if (typeof document.info?.version !== "string") {
    return "the body has no `info.version` string";
  }
  if (
    typeof document.paths !== "object" ||
    document.paths === null ||
    Array.isArray(document.paths)
  ) {
    return "the body has no `paths` object";
  }
  return undefined;
}

/** The committed contract as written to disk: two-space indent, one trailing
 *  newline. The generator, Check B and the CI drift step all read this file, so
 *  the formatting is fixed here and nowhere else. */
export function serializeContract(document: ContractDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function fetchContract(): Promise<ContractDocument> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(CONTRACT_URL, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        lastFailure = `HTTP ${response.status} ${response.statusText}`;
      } else {
        const body: unknown = await response.json();
        const problem = contractProblem(body);
        if (problem) {
          lastFailure = problem;
        } else {
          return body as ContractDocument;
        }
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) {
      console.error(
        `attempt ${attempt}/${ATTEMPTS} failed (${lastFailure}), retrying`,
      );
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`could not fetch ${CONTRACT_URL}: ${lastFailure}`);
}

/** The version in the file on disk, or `undefined` on a first fetch. */
async function committedVersion(): Promise<string | undefined> {
  const file = Bun.file(OUTPUT);
  if (!(await file.exists())) return undefined;
  try {
    const document: unknown = await file.json();
    const version = (document as Partial<ContractDocument>)?.info?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const before = await committedVersion();
  const document = await fetchContract();
  await Bun.write(OUTPUT, serializeContract(document));
  console.log(`contract/openapi.json <- ${CONTRACT_URL}`);
  console.log(`  was: ${before ?? "(no committed contract)"}`);
  console.log(`  now: ${document.info.version}`);
  if (before === document.info.version) {
    console.log("  no version change; the body may still differ");
  }
}
