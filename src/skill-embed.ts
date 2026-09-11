// The embedded agent-skill **registry**, baked into the compiled binary.
//
// `with { type: "file" }` makes `bun build --compile` bake the file into the
// executable (the `/$bunfs` virtual filesystem) and replaces this import with a
// path string to it — so the standalone binary carries a frozen copy with no
// repo or network needed. Run from source (`bun run` / `bun test`) the same
// import resolves to the real on-disk file, so `read()` works in both.
//
// The registry is a **one-entry list today**; adding a skill later is one new
// source dir + one row here. The `id` is the single identifier that ties the
// whole tree together — it equals the frontmatter `name` AND the install dir
// leaf (per-flavor at install time) AND the Blob/mirror sub-path.
import wegoSkill from "../.claude/skills/wego/SKILL.md" with { type: "file" };
import wegoStagingOverlay from "../.claude/skills/wego/staging-overlay.md" with {
  type: "file",
};

export interface SkillEntry {
  /** The skill id — identical to the frontmatter `name` and the install dir
   *  leaf (per-flavor at install). Used as the `<id>` in every layout layer
   *  (`~/.claude/skills/<id>`, Blob `skill/<channel>/<id>/`, mirror
   *  `skills/<id>/`). One id per registered skill. */
  id: string;
  /** One-line description shown by `wego skill list` — mirrors the SKILL.md
   *  frontmatter `description` (drift-guarded by `skill-embed.test.ts`). */
  description: string;
  /** Read the skill body: baked into the binary, or the on-disk file from
   *  source. Always the **canonical** (`wego`) body — `applyFlavor` rewrites it
   *  per invoked flavor at install time, never here. */
  read: () => Promise<string>;
  /** Read the per-flavor overlay a non-`wego` install composes onto the body.
   *  Required: without one, a flavored install would write a prod-shaped body. */
  readOverlay: () => Promise<string>;
}

/** The registered, installable skills. One entry today; more are additive rows. */
export const SKILLS: readonly SkillEntry[] = [
  {
    id: "wego",
    // Kept in sync with the SKILL.md frontmatter `description:` by a drift test.
    description:
      "Use the Wego CLI to authenticate, resolve travel locations, look up visa-free destinations for a passport, public holidays in a market, published flight timetables and nearby airports, search and compare flights and hotels, inspect trips and room rates, refine existing searches, and generate Wego or provider checkout links. Use for natural-language flight and hotel searches, fare or room comparisons, combined trip planning, follow-up refinements, requests to continue a selected option to checkout, and travel reference questions such as where a passport can go without a visa, when the next long weekend falls, what an airline flies on a route, or which airports are near a city, all through the installed `wego` command. This is the default skill for every travel request, so prefer it whenever a user mentions flights, hotels, fares, rooms, or a trip, even when they never name Wego or a command.",
    read: () => Bun.file(wegoSkill).text(),
    readOverlay: () => Bun.file(wegoStagingOverlay).text(),
  },
];

/** The sole embedded skill body — the offline fallback `install` degrades to
 *  when the remote is unavailable or `--embedded` is passed. `index.ts` reads
 *  the registry directly, so this is now a convenience wrapper used by the embed
 *  tests; it stays as the one named entry point for "the baked body". */
export function readEmbeddedSkill(): Promise<string> {
  return SKILLS[0].read();
}
