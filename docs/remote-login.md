# Logging in on a remote machine (SSH)

## The problem

`wego login` is RFC 8252 loopback PKCE: the CLI starts an HTTP listener on
`127.0.0.1:<ephemeral port>` and passes that as the `redirect_uri`. That is
correct — and machine-local by construction.

Over SSH the two halves land on different machines:

| Half | Where it runs |
|---|---|
| the loopback listener (`src/loopback.ts`) | the **remote** box |
| the browser that the AS redirects | the **laptop** |

So the AS sends the laptop's browser to `http://127.0.0.1:<port>/callback?code=…`,
where nothing is listening. The login hangs until its deadline. The old
workaround was a second SSH session plus a hand-written `curl` at the remote
loopback.

## The fix: paste the redirect URL back

The authorization code is not lost — it sits in the browser's address bar. So
the CLI also reads a pasted callback URL from the terminal
(`src/paste-callback.ts`), and races that against the loopback:

- **Automatic in an SSH session** (`SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY`).
  The CLI opens no browser there — one would render on the wrong display, or
  nowhere — prints the authorize URL, and waits for the paste.
- **`wego login --no-browser`** forces the same flow anywhere (a container, a
  tmux session on a display-less host) — every remote shell the SSH markers
  miss, including `docker exec`, `kubectl exec` and `sudo -i`.
- **`wego login --browser`** overrides the detection the other way, for an SSH
  session that *can* reach a browser on the remote machine (X11 forwarding).
  The two flags are mutually exclusive; passing both is a usage error.
- **Both paths stay live.** The loopback is never disarmed, so a forwarded port
  still completes the login by itself, and whichever arrives first wins.

Nothing else changes: the `redirect_uri` sent to `/authorize` is the same
loopback URI, the PKCE verifier never leaves the process, and the pasted URL
must carry the same CSRF `state` — `interpretCallback` is the one interpreter
for both paths, so a foreign redirect cannot finish someone else's login.

Non-TTY stdin (an agent shelling out, `curl … | bash`) arms no reader — there is
nobody to paste. That case keeps the loopback's own 5-minute deadline and says
so in the printed hint (forward the port, or re-run from an interactive
terminal); only an armed reader raises the deadline to 10 minutes
(`PASTE_TIMEOUT_MS`), sized for the paste round-trip.

## The alternative: forward the port

When you can plan the SSH session, pin the redirect port and tunnel it, and the
ordinary flow completes with no paste:

```sh
ssh -L 8765:localhost:8765 you@remote
WEGO_CLI_REDIRECT_PORT=8765 wego login
```

`WEGO_CLI_REDIRECT_PORT` predates this work (it exists for AS clients that
register a fixed loopback port). It needs the tunnel up *before* login, and the
port must be registered/allowed by the AS if it does not honour the RFC 8252
port override — which is why the paste path, not this one, is the default.

## Not done: device authorization grant

RFC 8628 (`device_code` + a short user code on `auth.wego.com/device`) is the
purpose-built answer for input-limited and remote environments, and would drop
the copy-paste step entirely. It needs a device-authorization endpoint on
`auth.wego.com` and the client registered for that grant — upstream B1 work (see
`UPSTREAM-B1.md`), not client-side. The paste flow needs no AS change, so it
ships first.
