// `with { type: "file" }` makes `bun build --compile` bake the file into the
// executable (the `/$bunfs` virtual filesystem) and replaces this import with a
// path to it, so the binary carries a frozen copy. From source the same import
// resolves to the on-disk file, so `read()` works in both.
import wegoSkill from "../skills/wego/SKILL.md" with { type: "file" };

export interface SkillEntry {
  /** Equals the frontmatter `name` and the install dir leaf
   *  (`~/.claude/skills/<id>`). */
  id: string;
  /** Shown by `wego skill list`. Must match the SKILL.md frontmatter
   *  `description`; `skill-embed.test.ts` guards the drift. */
  description: string;
  /** The body every install writes, byte for byte. */
  read: () => Promise<string>;
}

export const SKILLS: readonly SkillEntry[] = [
  {
    id: "wego",
    description:
      "Use the Wego CLI to authenticate, resolve travel locations, look up visa-free destinations for a passport, public holidays in a market, published flight timetables and nearby airports, search and compare flights and hotels, inspect trips and room rates, refine existing searches, and generate Wego or provider checkout links. Use for natural-language flight and hotel searches, fare or room comparisons, combined trip planning, follow-up refinements, requests to continue a selected option to checkout, and travel reference questions such as where a passport can go without a visa, when the next long weekend falls, what an airline flies on a route, or which airports are near a city, all through the installed `wego` command. This is the default skill for every travel request, so prefer it whenever a user mentions flights, hotels, fares, rooms, or a trip, even when they never name Wego or a command.",
    read: () => Bun.file(wegoSkill).text(),
  },
];

/** The sole embedded skill body. Only the embed tests use it; `skill.ts` reads
 *  the registry directly. */
export function readEmbeddedSkill(): Promise<string> {
  return SKILLS[0].read();
}
