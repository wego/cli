# `wego` CLI

The `wego` command — a public OAuth + PKCE client that logs you in with
`auth.wego.com` and drives the Wego API as you. One binary serves every backend;
`--target prod|staging|local` picks it at run time.

```sh
bun install
bun test
bun run lint
bun run typecheck
```

`.envrc` prepends `.bin` to `PATH`, so `wego` runs the TypeScript source with no
compile step.

The extraction of this repository out of `wego-ai`, and the release, signing and
ring machinery that goes with it, is tracked in
[wego/foundations#127](https://github.com/wego/foundations/issues/127).
