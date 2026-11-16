import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const files = [
  "skills/wego/SKILL.md",
  "skills/wego/references/cli.md",
  "skills/wego/references/mcp.md",
];
const rewrites: { old: string; new: string; file: string }[] = [
  {
    old: "| This skill itself looks stale, or the user wants it in another agent | `wego skill list` shows what is installable (offline, no auth) and `wego skill install` refreshes this file in place – it fetches the current published body, checksum-verifies it, and falls back to the copy baked into the binary when the network is unavailable, so it never fails on a down remote. Writing files needs the user's approval first, like an update. To set the skill up for another coding agent, that same subcommand takes `--agent <name>` (repeatable, `'*'` for all) and `-g` for a user-wide install; omitted, it targets the agents already present. |",
    new: "| This skill itself looks stale, or the user wants it in another agent | `wego skill list` shows what is installable (offline, no auth) and `wego skill install` writes the skill files embedded in the running binary. Writing files needs the user's approval first, like an update. To set the skill up for another coding agent, that same subcommand takes `--agent <name>` (repeatable, `'*'` for all) and `-g` for a user-wide install; omitted, it targets the agents already present. |",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "**Where things are.** Read the operating contract first, then jump to the vertical the request needs:",
    "new":
      "**Where things are.** Read the operating contract first, then open only the reference for your path:",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "- **Operating contract** – preflight, metering, currency, the rules that bind every command. Always applies.",
    "new":
      "- **CLI contract** – preflight, currency, and the rules that bind every CLI command.",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "- **Without the CLI (Wego MCP tools)** – what still applies when Operating contract item 2 sends you to the MCP tools, and what to do when no tool covers the task.",
    "new":
      "Open [references/mcp.md](references/mcp.md) only when item 2 sends you to the MCP tools.",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "1. Every command here is `wego <sub>`, the Wego CLI documented at https://agents.wego.com/cli. Keep to the path item 2 picks for the whole workflow. Both the CLI and the MCP tools read live inventory and prices. On either path, quote what it returns rather than estimating, and never invent a figure it did not give you.",
    "new":
      "**1.** Every command here is `wego <sub>`, the Wego CLI documented at https://agents.wego.com/cli. Keep to the path item 2 picks for the whole workflow. Both the CLI and the MCP tools read live inventory and prices. On either path, quote what it returns rather than estimating, and never invent a figure it did not give you.",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "2. The CLI is the default, because it does more than the Wego MCP tools (`flights_search`, `hotels_search`, `places_find_location` and the rest; your client may add a prefix to the names). Use the MCP tools only in one of these three cases, never by preference:",
    "new":
      "**2.** The CLI is the default, because it does more than the Wego MCP tools (`flights_search`, `hotels_search`, `places_find_location` and the rest; your client may add a prefix to the names). Use the MCP tools only in one of these three cases, never by preference:",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "   - **`wego` is installed but cannot reach the network:** a command exits `7` and its stderr reads `Cannot reach the Wego API at <url>`. Make the one bounded retry in Recover safely; if it fails the same way, use the MCP tools.",
    "new":
      "   - **`wego` is installed but cannot reach the network:** a command exits `7` and its stderr reads `Cannot reach the Wego API at <url>`. Make the one bounded retry in [Recover safely](references/cli.md#recover-safely); if it fails the same way, use the MCP tools.",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "   In every other case `wego version` works: use the CLI, and the rest of this file applies as written. When a case sends you to the MCP tools and they are not connected, tell the user how to connect the Wego MCP server, as in the first case. See **Without the CLI (Wego MCP tools)** for the rules that still apply there.",
    "new":
      "   In every other case `wego version` works: use the CLI and open [references/cli.md](references/cli.md). When a case sends you to the MCP tools, open [references/mcp.md](references/mcp.md). If they are not connected, tell the user how to connect the Wego MCP server, as in the first case.",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "3. Run `wego whoami` before the first authenticated travel command when session state is unknown. If login is required, run its `login` subcommand, tell the user to complete the browser flow, then resume the original request. Login only completes by itself when the user's browser is on the machine that runs the CLI, and your shell is not a TTY, so you can never complete the paste fallback yourself. When stderr says no browser is on this machine, or that this terminal cannot read a paste, treat login as the user's action: ask them to run `login` in their own interactive terminal on that machine, then re-check with `whoami` (see Login environments). Never ask for an access token, and never read or print the credentials file.",
    "new":
      "**3.** Run `wego whoami` before the first authenticated travel command when session state is unknown. If login is required, run its `login` subcommand, tell the user to complete the browser flow, then resume the original request. Login only completes by itself when the user's browser is on the machine that runs the CLI, and your shell is not a TTY, so you can never complete the paste fallback yourself. When stderr says no browser is on this machine, or that this terminal cannot read a paste, treat login as the user's action: ask them to run `login` in their own interactive terminal on that machine, then re-check with `whoami` (see Login environments). Never ask for an access token, and never read or print the credentials file.",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "4. Treat successful stdout from `whoami`, `places`, `info *`, `flights *`, and `hotels *` as JSON. `version` and `help` intentionally print plain text; login and logout are status flows. Treat stderr as status or recovery guidance. Non-empty stderr is not by itself a failure: a **successful** command can carry a hint, or the new-version notice, alongside valid stdout JSON and an exit code of `0`. On failure, stdout stays empty and stderr still carries a single actionable line – the error class and detail, a `trace_id=…` (quote it to Wego support), a Retry-After hint when present, and the next action (for example `run \\`wego login\\``). Do not scrape identifiers from human-readable error text when the same value exists in JSON. Branch on the process exit code (see Exit codes), not on stderr wording, which is not a stable contract.",
    "new":
      "**4.** Treat successful stdout from `whoami`, `places`, `info *`, `flights *`, and `hotels *` as JSON. `version` and `help` intentionally print plain text; login and logout are status flows. Treat stderr as status or recovery guidance. Non-empty stderr is not by itself a failure: a **successful** command can carry a hint, or the new-version notice, alongside valid stdout JSON and an exit code of `0`. On failure, stdout stays empty and stderr still carries a single actionable line – the error class and detail, a `trace_id=…` (quote it to Wego support), a Retry-After hint when present, and the next action (for example `run \\`wego login\\``). Do not scrape identifiers from human-readable error text when the same value exists in JSON. Branch on the process exit code (see Exit codes), not on stderr wording, which is not a stable contract.",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "5. Quote free-text and identifiers passed to the shell. Do not use `eval` or compose executable shell fragments from user text.",
    "new":
      "**5.** Quote free-text and identifiers passed to the shell. Do not use `eval` or compose executable shell fragments from user text.",
    file: "skills/wego/references/cli.md",
  },
  {
    old: '6. Retain the user\'s original search inputs and the IDs returned by each command. Map follow-ups such as "option 2" back to the corresponding object in the most recent result.',
    "new":
      '**6.** Retain the user\'s original search inputs and the IDs returned by each command. Map follow-ups such as "option 2" back to the corresponding object in the most recent result.',
    file: "skills/wego/SKILL.md",
  },
  {
    old: "7. Present a concise ranked comparison instead of raw JSON. Include only decision-relevant fields such as total price, duration, stops, baggage, rating, board, and refundability.",
    "new":
      "**7.** Present a concise ranked comparison instead of raw JSON. Include only decision-relevant fields such as total price, duration, stops, baggage, rating, board, and refundability.",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "8. Ask only for missing user-facing inputs. Do not ask the user for `searchId`, `tripId`, `fareId`, `fareOptionId`, `hotelId`, or `rateId` when they appeared in earlier output.",
    "new":
      "**8.** Ask only for missing user-facing inputs. Do not ask the user for `searchId`, `tripId`, `fareId`, `fareOptionId`, `hotelId`, or `rateId` when they appeared in earlier output.",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "9. Establish the pricing preferences BEFORE the first priced command. Run `wego config list`: it prints `currency`, `site` and `locale`, each with the layer that decided it – `setting` (the user's stored preference), `account` (the market on their Wego account, site only), or `default` (the API's USD / en / US floor). When `currency` or `site` reads `default`, ask the user once, in a single question, which currency to price in and which market they buy from – naming the account market if there is one. A request for answers in another language triggers that question on its own, even when currency and site are both already stored, and folds into it when they are not: name the language their results come back in, and persist it only if they agree. Then persist ONLY what they actually said:",
    "new":
      "**9.** Establish the pricing preferences BEFORE the first priced command. Run `wego config list`: it prints `currency`, `site` and `locale`, each with the layer that decided it – `setting` (the user's stored preference), `account` (the market on their Wego account, site only), or `default` (the API's USD / en / US floor). When `currency` or `site` reads `default`, ask the user once, in a single question, which currency to price in and which market they buy from – naming the account market if there is one. A request for answers in another language triggers that question on its own, even when currency and site are both already stored, and folds into it when they are not: name the language their results come back in, and persist it only if they agree. Then persist ONLY what they actually said:",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "10. Preserve currency, market and locale throughout a funnel. With a stored setting, every command inherits it, so a read no longer reverts to USD – but an explicit flag still wins for that one command, and mixing the two inside one funnel is how a riyal price ends up compared against a dollar price. **A `searchId` remembers no currency.** So a search created with an explicit `--currency` must carry that same `--currency` on every later `results` / `trip` / `fares` read of it: omit it and the read is repriced into the stored preference, or into the API's USD when nothing is stored, and the two snapshots stop being comparable. Every read echoes the `currencyCode` it priced in – compare it against the one the search reported before you quote a number. **Every priced read echoes a `currencyCodeSource` beside that `currencyCode`** – both `search`es, both `results` reads, `trip`, `fares`, and both `rooms` forms – naming the layer that decided the unit: `explicit` (a `--currency` on that command), `setting` (the user's stored currency), or `default` (nobody chose one, so the API priced in USD). Read it before you quote the first number: on `default`, state the currency instead of letting the digits imply it, and offer contract item 9's one question; on `setting`, name the stored currency rather than presenting it as a choice made for this trip. It names the unit the command **asked** for, so when the top-level `currencyCode` differs from `metadata.currencyCode`, the price was not converted into the currency asked for: say that, rather than quoting the number as if it were in the requested currency. Every `*Source` field is **top level and there is exactly one per knob** – the CLI strips the API's own request-scoped copies from `metadata` before printing, so a payload never carries two answers to \"who decided\". There is no locale equivalent, by design: locale changes the language of the text, not the number, so no CLI output carries a `localeSource`. It still has to be asked for. When the user asks for their answers in another language, pass `--locale` on the reads whose text you will quote back to them, because the names in a Wego answer, the airlines, cities, airports, countries and holidays, come back in the language the read asked for. Translating them yourself puts your wording in front of someone who may be matching it against a booking page. Codes and keys do not move with the locale, so nothing you thread through the funnel changes: an English query still resolves `RUH` under `--locale ar`, and `results[].key` stays the same slug. Report the market when it was not explicit: `flights search` and `hotels search` echo a top-level `siteCode` beside a top-level `siteCodeSource` of `explicit`, `setting`, `account`, or `default`; `info schedules` reports the same top-level `siteCodeSource`, while its market value stays at `metadata.siteCode` – an echo only, since a published timetable does not vary by market. Confirm with the user when it reads `default`, or when the account market clearly mismatches the request (for example AED pricing against a `US` account). Do not infer a currency from the route, the destination, or a nationality. Market cannot change on `results` – a different market means a new search – and it must be re-supplied to the stateless `booking-link`.",
    "new":
      "**10.** Preserve currency, market and locale throughout a funnel. With a stored setting, every command inherits it, so a read no longer reverts to USD – but an explicit flag still wins for that one command, and mixing the two inside one funnel is how a riyal price ends up compared against a dollar price. **A `searchId` remembers no currency.** So a search created with an explicit `--currency` must carry that same `--currency` on every later `results` / `trip` / `fares` read of it: omit it and the read is repriced into the stored preference, or into the API's USD when nothing is stored, and the two snapshots stop being comparable. Every read echoes the `currencyCode` it priced in – compare it against the one the search reported before you quote a number. **Every priced read echoes a `currencyCodeSource` beside that `currencyCode`** – both `search`es, both `results` reads, `trip`, `fares`, and both `rooms` forms – naming the layer that decided the unit: `explicit` (a `--currency` on that command), `setting` (the user's stored currency), or `default` (nobody chose one, so the API priced in USD). Read it before you quote the first number: on `default`, state the currency instead of letting the digits imply it, and offer contract item 9's one question; on `setting`, name the stored currency rather than presenting it as a choice made for this trip. It names the unit the command **asked** for, so when the top-level `currencyCode` differs from `metadata.currencyCode`, the price was not converted into the currency asked for: say that, rather than quoting the number as if it were in the requested currency. Every `*Source` field is **top level and there is exactly one per knob** – the CLI strips the API's own request-scoped copies from `metadata` before printing, so a payload never carries two answers to \"who decided\". There is no locale equivalent, by design: locale changes the language of the text, not the number, so no CLI output carries a `localeSource`. It still has to be asked for. When the user asks for their answers in another language, pass `--locale` on the reads whose text you will quote back to them, because the names in a Wego answer, the airlines, cities, airports, countries and holidays, come back in the language the read asked for. Translating them yourself puts your wording in front of someone who may be matching it against a booking page. Codes and keys do not move with the locale, so nothing you thread through the funnel changes: an English query still resolves `RUH` under `--locale ar`, and `results[].key` stays the same slug. Report the market when it was not explicit: `flights search` and `hotels search` echo a top-level `siteCode` beside a top-level `siteCodeSource` of `explicit`, `setting`, `account`, or `default`; `info schedules` reports the same top-level `siteCodeSource`, while its market value stays at `metadata.siteCode` – an echo only, since a published timetable does not vary by market. Confirm with the user when it reads `default`, or when the account market clearly mismatches the request (for example AED pricing against a `US` account). Do not infer a currency from the route, the destination, or a nationality. Market cannot change on `results` – a different market means a new search – and it must be re-supplied to the stateless `booking-link`.",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "11. Never claim that a booking, reservation, payment, cancellation, or modification occurred. This CLI searches and generates checkout links only.",
    "new":
      "**11.** Never claim that a booking, reservation, payment, cancellation, or modification occurred. This CLI searches and generates checkout links only.",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "12. Creating a search and reading a hotel's rooms are metered. This API is a research preview, so those limits are deliberate and fairly tight (the current figures are at https://agents.wego.com/api/rate-limits/) – say so whenever one is reached, including one you waited out and worked around (see Finish the answer). Plan inside that budget rather than discovering it: never open one search per airport, per date, or per hotel. When a request implies many, run a small first batch, present it, and ask the user which to expand – that is also a better conversation than a wall of options. Reads against an existing `searchId` (`results`, `trip`, `fares`) are far cheaper than a new search, so refine an existing search instead of creating another whenever the constraint can be expressed as a flag. `hotels rooms` is the one read that always mints a search of its own, one per hotel, so open it for the hotels the user actually picked rather than sweeping a results page with it.",
    "new":
      "**12.** Creating a search and reading a hotel's rooms are metered. This API is a research preview, so those limits are deliberate and fairly tight (the current figures are at https://agents.wego.com/api/rate-limits/) – say so whenever one is reached, including one you waited out and worked around (see [Finish the answer](references/cli.md#finish-the-answer)). Plan inside that budget rather than discovering it: never open one search per airport, per date, or per hotel. When a request implies many, run a small first batch, present it, and ask the user which to expand – that is also a better conversation than a wall of options. Reads against an existing `searchId` (`results`, `trip`, `fares`) are far cheaper than a new search, so refine an existing search instead of creating another whenever the constraint can be expressed as a flag. `hotels rooms` is the one read that always mints a search of its own, one per hotel, so open it for the hotels the user actually picked rather than sweeping a results page with it.",
    file: "skills/wego/SKILL.md",
  },
  {
    old: "   When the CLI is already present but the user wants the latest, or its syntax",
    "new":
      "When the CLI is already present but the user wants the latest, or its syntax",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   looks out of date, `wego update --check` reports whether a newer build exists",
    "new":
      "looks out of date, `wego update --check` reports whether a newer build exists",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   (read-only, no approval needed). Self-replacing the installed binary is a",
    "new":
      "(read-only, no approval needed). Self-replacing the installed binary is a",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   significant action: get the user's approval before running the",
    "new": "significant action: get the user's approval before running the",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   self-replacing `wego update -y` (add `-y` since an agent shell",
    "new": "self-replacing `wego update -y` (add `-y` since an agent shell",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   isn't a TTY). It verifies the download against the published checksums and",
    "new":
      "isn't a TTY). It verifies the download against the published checksums and",
    file: "skills/wego/references/cli.md",
  },
  {
    old: '   needs no reinstall. A from-source run prints a "reinstall" hint instead',
    "new":
      'needs no reinstall. A from-source run prints a "reinstall" hint instead',
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   (nothing to replace).",
    "new": "(nothing to replace).",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   Both forms follow the release ring the **installer** recorded, and name it in",
    "new":
      "Both forms follow the release ring the **installer** recorded, and name it in",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   what they print. An install with no record – installed before the record",
    "new":
      "what they print. An install with no record – installed before the record",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   existed, or with the record deleted – refuses both forms with exit code 6 and",
    "new":
      "existed, or with the record deleted – refuses both forms with exit code 6 and",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   prints a reinstall command. If the user **directly asked** to",
    "new": "prints a reinstall command. If the user **directly asked** to",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   update or check, that exit 6 means the requested action failed: state that",
    "new":
      "update or check, that exit 6 means the requested action failed: state that",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   result, give the user that reinstall command to run themselves (as with a",
    "new":
      "result, give the user that reinstall command to run themselves (as with a",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   missing CLI), and do not report the update as done. Only when the check was an optional preflight for another task is it safe",
    "new":
      "missing CLI), and do not report the update as done. Only when the check was an optional preflight for another task is it safe",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   to note the refusal and carry on.",
    "new": "to note the refusal and carry on.",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   An installed CLI also **announces a new release itself**: any command except",
    "new":
      "An installed CLI also **announces a new release itself**: any command except",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   `update`, `uninstall`, and `skill` may print one stderr line naming the",
    "new":
      "`update`, `uninstall`, and `skill` may print one stderr line naming the",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   available version and `update -y`, and only when that command **succeeded** – a",
    "new":
      "available version and `update -y`, and only when that command **succeeded** – a",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   failure still carries exactly one stderr line. When you see it,",
    "new": "failure still carries exactly one stderr line. When you see it,",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   skip `update --check` – its presence already means a newer build exists – and do",
    "new":
      "skip `update --check` – its presence already means a newer build exists – and do",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   **not** interrupt work in progress. Finish the user's request, then mention it",
    "new":
      "**not** interrupt work in progress. Finish the user's request, then mention it",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   once at the end and offer `update -y` for their approval. Never parse the",
    "new":
      "once at the end and offer `update -y` for their approval. Never parse the",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "   version out of that line; treat its presence as the whole signal.",
    "new": "version out of that line; treat its presence as the whole signal.",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "Use this section only when Operating contract item 2 sends you to the MCP tools. Each tool describes its own arguments, polling and paging, so read the tool rather than mapping `wego` flags onto it.",
    "new":
      "Use this section only when Operating contract item 2 in [../SKILL.md](../SKILL.md) sends you to the MCP tools. Each tool describes its own arguments, polling and paging, so read the tool rather than mapping `wego` flags onto it.",
    file: "skills/wego/references/mcp.md",
  },
  {
    old: "- **Still applies:** contract items 6, 7, 8, 11 and 12. Quote only what a tool returned, keep the ids it returned for follow-ups, present a ranked comparison, never claim a booking, and plan inside the search limits.",
    "new":
      "- **Still applies:** Operating contract items 6, 7, 8, 11 and 12 in [../SKILL.md](../SKILL.md). Quote only what a tool returned, keep the ids it returned for follow-ups, present a ranked comparison, never claim a booking, and plan inside the search limits.",
    file: "skills/wego/references/mcp.md",
  },
  {
    old: "If no Wego MCP tool covers the task, tell the user this connection cannot do it, and never fill the gap from memory. Name the `wego` CLI, with a link to https://agents.wego.com/cli#install, only when a `wego` command in this file covers the task.",
    "new":
      "If no Wego MCP tool covers the task, tell the user this connection cannot do it, and never fill the gap from memory. Name the `wego` CLI, with a link to https://agents.wego.com/cli#install, only when a `wego` command in [cli.md](cli.md) covers the task.",
    file: "skills/wego/references/mcp.md",
  },
  {
    old: '`list` is the answer to "what am I being quoted in, and who decided that". Read it in preflight (operating contract item 9) and whenever the user questions a number: a `source` of `default` means nobody chose, so the API priced in USD for the `US` market.',
    "new":
      '`list` is the answer to "what am I being quoted in, and who decided that". Read it in preflight (CLI contract item 9) and whenever the user questions a number: a `source` of `default` means nobody chose, so the API priced in USD for the `US` market.',
    file: "skills/wego/references/cli.md",
  },
  {
    old: "Contract items 9 and 10 own the two rules that matter most here: get the user's word before `set` or `unset` writes to their machine, and use `--currency` / `--site` / `--locale` for a one-off instead of writing anything. One rule lives only here: **a broken file stops every command with exit 2**, naming the path. If a user hand-edited it into an invalid state, read that stderr line back to them, since it names the file and the offending value. Do not try to repair it silently.",
    "new":
      "CLI contract items 9 and 10 own the two rules that matter most here: get the user's word before `set` or `unset` writes to their machine, and use `--currency` / `--site` / `--locale` for a one-off instead of writing anything. One rule lives only here: **a broken file stops every command with exit 2**, naming the path. If a user hand-edited it into an invalid state, read that stderr line back to them, since it names the file and the offending value. Do not try to repair it silently.",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "| CLI missing, or you cannot run commands | Operating contract item 2. If you cannot run commands, use the Wego MCP tools, or tell the user how to connect the Wego MCP server. If `wego` is missing, link the install instructions and wait for the user to confirm; use the MCP tools only if they say they cannot install it in this environment. See Without the CLI (Wego MCP tools) when no tool covers the task. |",
    "new":
      "| CLI missing, or you cannot run commands | Operating contract item 2 in [../SKILL.md](../SKILL.md). If you cannot run commands, use the Wego MCP tools, or tell the user how to connect the Wego MCP server. If `wego` is missing, link the install instructions and wait for the user to confirm; use the MCP tools only if they say they cannot install it in this environment. See [mcp.md](mcp.md) when no tool covers the task. |",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "| CLI outdated, or a stderr line says a new version is available | Operating contract item 2 covers both: `update --check` is read-only, the self-replacing `update -y` needs the user's approval, and a from-source run prints a reinstall hint instead. The stderr notice is not an error and not a cue to stop, so finish the request first, then offer the update once. |",
    "new":
      "| CLI outdated, or a stderr line says a new version is available | The Update the CLI section above covers both: `update --check` is read-only, the self-replacing `update -y` needs the user's approval, and a from-source run prints a reinstall hint instead. The stderr notice is not an error and not a cue to stop, so finish the request first, then offer the update once. |",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "| Cannot reach the API / timeout (exit `7`) | The API host was unreachable or the request timed out. Check network connectivity, then make one bounded retry; the CLI's stderr line names the host it tried. If the retry fails with `Cannot reach the Wego API`, follow Operating contract item 2. |",
    "new":
      "| Cannot reach the API / timeout (exit `7`) | The API host was unreachable or the request timed out. Check network connectivity, then make one bounded retry; the CLI's stderr line names the host it tried. If the retry fails with `Cannot reach the Wego API`, follow Operating contract item 2 in [../SKILL.md](../SKILL.md). |",
    file: "skills/wego/references/cli.md",
  },
  {
    old: "| `7` | Timeout / network – host unreachable or deadline hit | Check the API is up/reachable, then retry. If it still cannot reach the API, follow Operating contract item 2. |",
    "new":
      "| `7` | Timeout / network – host unreachable or deadline hit | Check the API is up/reachable, then retry. If it still cannot reach the API, follow Operating contract item 2 in [../SKILL.md](../SKILL.md). |",
    file: "skills/wego/references/cli.md",
  },
];
const repeated = new Set([
  "---",
  "```bash",
  "```",
  "Follow this value chain:",
  "```text",
  "search inputs",
  "  -> bookingUrl",
  "### Create the search",
  "  [--adults N] [--children N] [--infants N] \\",
  "  [--site SG] [--currency USD] [--locale en]",
  "### Refine or paginate",
  "  [--wait] \\",
  "  [--page N] [--page-size N] \\",
  "  [--currency USD] [--locale en]",
  "  [--site SG] [--currency USD] [--locale en] \\",
  "  [--from-city] [--to-city]",
  "|---|---|---|",
  "  [--adults N] [--children N] [--children-ages 5,11] [--rooms N] \\",
]);
const old = execFileSync(
  "git",
  ["show", `${process.argv[2] ?? "a84ab75"}:skills/wego/SKILL.md`],
  { cwd: root, encoding: "utf8" },
);
const units = old.split("\n").filter((line) => line.trim());
const current = files.map((file) => ({
  file,
  lines: readFileSync(resolve(root, file), "utf8").split("\n"),
}));
const failures: string[] = [];
let verbatim = 0;
let rewritten = 0;
for (const unit of new Set(units)) {
  const replacement = rewrites.find((entry) => entry.old === unit);
  const expected = replacement?.new ?? unit;
  const hits = current.map(({ file, lines }) => ({
    file,
    count: lines.filter((line) => line === expected).length,
  }));
  const total = hits.reduce((sum, hit) => sum + hit.count, 0);
  const wanted = repeated.has(unit)
    ? units.filter((line) => line === unit).length
    : 1;
  if (
    total !== wanted ||
    (replacement &&
      hits.some((hit) => hit.file !== replacement.file && hit.count > 0))
  )
    failures.push(
      `${JSON.stringify(unit)}: expected ${wanted} in ${replacement?.file ?? "exactly one file"}, found ${JSON.stringify(hits)}`,
    );
  if (replacement) rewritten += 1;
  else verbatim += 1;
}
for (const replacement of rewrites) {
  if (!units.includes(replacement.old))
    failures.push(`Rewrite source absent: ${JSON.stringify(replacement.old)}`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Skill split proof: ${verbatim + rewritten} units checked, ${verbatim} verbatim, ${rewritten} rewritten.`,
);
