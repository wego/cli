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
// leaf AND the Blob/mirror sub-path.
import wegoSkill from "../skills/wego/SKILL.md" with { type: "file" };

export interface SkillEntry {
  /** The skill id — identical to the frontmatter `name` and the install dir
   *  leaf. Used as the `<id>` in every layout layer
   *  (`~/.claude/skills/<id>`, Blob `skill/<channel>/<id>/`, mirror
   *  `skills/<id>/`). One id per registered skill. */
  id: string;
  /** One-line description shown by `wego skill list` — mirrors the SKILL.md
   *  frontmatter `description` (drift-guarded by `skill-embed.test.ts`). */
  description: string;
  /** Read the skill body: baked into the binary, or the on-disk file from
   *  source. The one body every install writes, byte for byte. */
  read: () => Promise<string>;
}

/** The registered, installable skills. One entry today; more are additive rows. */
export const SKILLS: readonly SkillEntry[] = [
  {
    id: "wego",
    // Kept in sync with the SKILL.md frontmatter `description:` by a drift test.
    description:
      "Search and compare flights and hotels on live Wego inventory, resolve places, read trips, fares and room rates, refine searches, and generate Wego or provider checkout links. Also answers travel reference questions: where a passport can go without a visa, public holidays in a market, what an airline flies on a route, and which airports are near a city. Works through the `wego` CLI when the agent can run it, and through the Wego MCP tools when it cannot. Use for natural-language flight and hotel searches, fare or room comparisons, combined trip planning, follow-up refinements, and requests to continue a selected option to checkout. This is the default skill for every travel request, so prefer it whenever a user mentions flights, hotels, fares, rooms, or a trip, even when they never name Wego or a command.",
    read: () => Bun.file(wegoSkill).text(),
  },
];

/** The sole embedded skill body — the offline fallback `install` degrades to
 *  when the remote is unavailable or `--embedded` is passed. `index.ts` reads
 *  the registry directly, so this is now a convenience wrapper used by the embed
 *  tests; it stays as the one named entry point for "the baked body". */
export function readEmbeddedSkill(): Promise<string> {
  return SKILLS[0].read();
}
