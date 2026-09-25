import { basename } from "node:path";

/**
 * The name the CLI was invoked as (`wego`, `wegostaging` or a renamed binary), so
 * output names the command the user typed.
 *
 * A compiled Bun binary bakes `process.argv[1]` to its build-time outfile
 * (`/$bunfs/root/wego-darwin-arm64`), so `process.execPath` is used instead. From
 * source it is `bun` or `node`, so fall back to `wego`. `.exe` is stripped first
 * for Windows.
 */
export function programName(execPath: string = process.execPath): string {
  const name = basename(execPath).replace(/\.exe$/i, "");
  return name === "bun" || name === "node" ? "wego" : name;
}

/**
 * Decided by the exec path, not `WEGO_BUILD_VERSION`, which a stray shell export
 * can set on a source run. `uninstall` and `update` gate their destructive
 * self-operations on this; otherwise a source run could treat `bun` as the
 * installed binary and delete or overwrite the runtime.
 */
export function runningFromSource(
  execPath: string = process.execPath,
): boolean {
  const name = basename(execPath).replace(/\.exe$/i, "");
  return name === "bun" || name === "node";
}
