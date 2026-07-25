# get.enconvert.com

Cloudflare Worker that serves the CLI installer surface. It proxies three
assets from the **latest GitHub release** of `enconvert/cli` (with a
main-branch fallback for the scripts before the first release exists):

| Path | Purpose |
|---|---|
| `/install.sh` | `curl -fsSL https://get.enconvert.com/install.sh \| sh` |
| `/install.ps1` | `irm https://get.enconvert.com/install.ps1 \| iex` |
| `/latest-version` | bare semver; read by install.sh and the CLI update notifier |

Tagging a release updates what this Worker serves automatically (5-minute edge
cache). No server, no per-release deploy step.

## Deploy

```sh
cd infra/get-worker
npx wrangler@latest login     # Cloudflare account owning the enconvert.com zone
npx wrangler@latest deploy    # also creates the get.enconvert.com DNS record
```

## Security posture (required)

Cloudflare's zone security products run BEFORE Workers. `get.enconvert.com`
must be exempted from Bot Fight Mode / Managed Challenge exactly like
`api.enconvert.com` is (2026-07-16 incident): a challenged `curl | sh` pipes an
HTML challenge page into the user's shell. The Worker refuses to forward HTML
bodies as a last line of defence, which turns a challenge into a clean 404 —
but the exemption is still required for installs to work.

## Verify after deploy

```sh
curl -fsSL https://get.enconvert.com/install.sh | head -1     # -> #!/bin/sh
curl -fsSL https://get.enconvert.com/install.ps1 | head -1    # -> a PowerShell comment/param line
curl -fsS  https://get.enconvert.com/latest-version           # -> 1.0.0 (404 until the first release)
curl -fsSL -A "Mozilla/5.0" https://get.enconvert.com/install.sh | head -1   # browser UA must get the same bytes
```
