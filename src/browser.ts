import { spawn } from "node:child_process";

type LaunchedChild = {
  on(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
};

/** Injectable so tests can assert the launch without opening a real browser tab
 *  on the developer's machine. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; detached: boolean },
) => LaunchedChild;

export function openCommand(
  platform: NodeJS.Platform,
  url: string,
): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  // Not `cmd /c start`: cmd re-parses its command line, treating the authorize
  // URL's `&` as command separators and expanding `%..%` (the percent-encoded
  // `redirect_uri`, e.g. `http%3A%2F%2F127.0.0.1...`) as env vars, and either
  // corrupts the URL. rundll32's URL handler receives the URL as a literal argv
  // with no shell parsing. POSIX openers (`open`/`xdg-open`) likewise take the
  // URL verbatim.
  if (platform === "win32")
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** Best-effort. The login flow also prints the URL, so a headless environment
 *  (or a failure here) degrades to copy-paste rather than breaking. */
export function openBrowser(url: string, spawnFn: SpawnFn = spawn): void {
  const [cmd, args] = openCommand(process.platform, url);
  try {
    const child = spawnFn(cmd, args, {
      stdio: "ignore",
      detached: true,
    });
    // A missing launcher (e.g. headless CI) surfaces as an async 'error' event;
    // swallow it so it doesn't become an unhandled error. The URL is printed too.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore: the URL is printed for manual opening.
  }
}
