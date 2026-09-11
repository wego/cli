import { basename } from "node:path";

/**
 * The name the CLI was invoked as — `wego` (prod), `wegostaging` (staging), or
 * whatever the binary was installed/renamed to — so user-facing output names the
 * command the user actually typed instead of a hardcoded `wego`.
 *
 * A compiled Bun binary bakes `process.argv[1]` to its build-time outfile
 * (`/$bunfs/root/wego-darwin-arm64`), so that's useless; `process.execPath`
 * is the real on-disk path, whose basename is the invoked command. Run from source
 * (`bun run src/index.ts …`) it's `bun`/`node`, so fall back to `wego`.
 *
 * The trailing `.exe` is stripped first so Windows works: `bun.exe`/`node.exe`
 * still fall back to `wego`, and a `wego.exe` / `wegostaging.exe` binary reports
 * `wego` / `wegostaging` (without the `.exe`).
 */
export function programName(execPath: string = process.execPath): string {
  const name = basename(execPath).replace(/\.exe$/i, "");
  return name === "bun" || name === "node" ? "wego" : name;
}

/**
 * True when the CLI is running from source (`bun run src/index.ts …`) rather than
 * an installed/compiled binary. Decided by the runtime **exec-path** (the same
 * `bun`/`node` basename signal `programName` uses), NOT the env-stamped
 * `WEGO_BUILD_VERSION` — which a stray shell export can spoof on a source run.
 *
 * `uninstall`/`update` gate their destructive self-operations on this: without it,
 * a source run that happens to inherit `WEGO_BUILD_VERSION` would treat `bun`
 * (`process.execPath`) as an installed binary and delete/overwrite the runtime.
 */
export function runningFromSource(
  execPath: string = process.execPath,
): boolean {
  const name = basename(execPath).replace(/\.exe$/i, "");
  return name === "bun" || name === "node";
}
