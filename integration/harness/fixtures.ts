/**
 * Fixtures: one API answer per file under `integration/fixtures/`, each naming the
 * operation it answers so the contract check knows which schema applies.
 *
 * They are written by hand, usually by copying or editing another one, and
 * `fixtures.test.ts` checks every one against the contract, so a contract refresh
 * that invalidates a fixture fails it by name.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Answer, Route } from "./fake";

export const FIXTURES_DIR = fileURLToPath(
  new URL("../fixtures/", import.meta.url),
);

export interface Fixture {
  op: string;
  status: number;
  body: unknown;
}

export function readFixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8"),
  ) as Fixture;
}

export function allFixtures(): [string, Fixture][] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      return [name, readFixture(name)];
    });
}

/** A fixture as an answer, optionally with its body adjusted for one scenario. */
export function answer<T = Record<string, unknown>>(
  name: string,
  edit?: (body: T) => unknown,
): Answer {
  const f = readFixture(name);
  const body = structuredClone(f.body) as T;
  return { status: f.status, body: edit ? edit(body) : body };
}

/** A route answering with fixtures, its operation read from the first one. */
export function route(
  ...answers: (string | Answer)[]
): Route & { answers: Answer[] } {
  const first = answers.find((a): a is string => typeof a === "string");
  if (!first) throw new Error("route: name at least one fixture");
  return {
    op: readFixture(first).op,
    answers: answers.map((a) => (typeof a === "string" ? answer(a) : a)),
  };
}
