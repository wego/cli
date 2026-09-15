<!--
Your PR TITLE must be a Conventional Commit, e.g. `fix(update): …`.
PRs are squashed, so the title becomes the commit subject and release-please
reads it to compute the next version. Getting it wrong skips or mis-sizes a
release.
-->

## What and why

<!-- What changes, and what problem it solves. Link an issue if there is one. -->

## How it was checked

<!-- What you ran, and what you saw. Say so plainly if something is untested. -->

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun test`

## Anything a reviewer should look at closely

<!-- Trade-offs, alternatives you rejected, anything you are unsure about.
     Delete this section if there is nothing. -->

---

- [ ] Commits are signed off (`git commit -s`), per the DCO check
- [ ] The title is a Conventional Commit and sizes the release correctly
