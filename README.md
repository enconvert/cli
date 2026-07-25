# enconvert

The official **[Enconvert](https://enconvert.com) CLI** — convert files, render URLs, and extract web data from your terminal. A thin, fast client for the Enconvert API: 46 file-conversion routes, URL/site-to-PDF/screenshot/markdown rendering, and the full v2 web-data surface (perceive, discover, lookup, distill, ingest), with `gh`-grade plumbing — `--json`, profiles, shell completion, documented exit codes, and a raw `api` passthrough that reaches every endpoint.

## Install

**Homebrew** (macOS and Linux):

```bash
brew tap enconvert/tap        # Homebrew 6 asks you to trust third-party taps:
                              #   Warning: tap enconvert/tap is untrusted. Trust it? [y/N] y
brew install enconvert
```

**Scoop** (Windows):

```powershell
scoop bucket add enconvert https://github.com/enconvert/scoop-bucket
scoop install enconvert
```

**Shell installer** (macOS, Linux, Alpine/musl — downloads the binary and verifies its **sha256 checksum** before installing; never edits your rc files unless you pass `-y`):

```bash
curl -fsSL https://get.enconvert.com/install.sh | sh
```

```powershell
irm https://get.enconvert.com/install.ps1 | iex
```

**npm** (Node >= 22.12):

```bash
npm i -g @enconvert/cli
```

**Direct binaries**: signed archives for macOS (x64/arm64), Linux (x64/arm64, glibc and musl) and Windows x64 on the [releases page](https://github.com/enconvert/cli/releases), each with a checksums file and [build provenance](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations) you can verify with `gh attestation verify --repo enconvert/cli`.

## Quick start

```bash
# Auth
enconvert auth login                          # interactive, hidden paste
enconvert auth login --with-token < key.txt   # CI-safe: stdin, never argv
export ENCONVERT_API_KEY=sk_...               # or just this
enconvert whoami --json                       # {"project_id":"...","plan_slug":"pro"}

# Convert files — endpoint inferred from extension + --to
enconvert convert report.docx --to pdf                     # → ./report.pdf
enconvert convert *.docx --to pdf -O out/ --skip-existing  # one path per line on stdout
enconvert convert photo.heic --to webp -o thumb.webp
enconvert convert diagram.svg --to png -o - | pbcopy       # bytes to stdout
enconvert convert data.json --to yaml                      # the 11 data routes
enconvert compress hero.png --target-size-kb 200
enconvert pdf slides.pptx                                  # anything-to-pdf
enconvert markdown paper.pdf                               # anything-to-markdown
enconvert formats --from heic                              # valid targets for HEIC

# Render URLs
enconvert url pdf https://example.com --viewport-width 1440 --no-single-page
enconvert url screenshot https://example.com --block-ads --wait-for-selector '#main'
enconvert site pdf https://example.com --crawl-mode sitemap --wait   # 202 → poll → ZIP

# V2 web data
enconvert perceive https://example.com --output markdown,links,screenshot -O ./out
enconvert perceive batch --input-file urls.txt --output-mode zip --wait --jsonl
enconvert discover https://example.com --mode hybrid --max-urls 500 --jsonl
enconvert lookup "best pdf api 2026" --num-results 20 --synthesize-answer
enconvert distill https://a.com https://b.com --schema-file schema.json
enconvert ingest create https://docs.example.com --mode crawl --max-pages 200 --no-wait

# Jobs and raw API
enconvert ingest create https://x.com --no-wait --json | jq -r .job_id | xargs enconvert jobs wait
enconvert api /v1/whoami --jq .plan_slug
enconvert api /v2/perceive -f url=https://example.com -F mobile=true
```

## Authentication

The CLI authenticates with a **secret key** (`sk_...`) from your [dashboard](https://enconvert.com/dashboard/api-keys). Resolution order: `--api-key` (supports `@file` and `-` for stdin) → `ENCONVERT_API_KEY` → a `credential_helper` command in your config (1Password, `pass`, Vault, ...) → `credentials.toml` written by `enconvert auth login`. `enconvert auth status` tells you which source is active. Keys are redacted to `sk_…abcd` in all output, including `--debug`.

## Output & scripting

The contract: **stdout carries the artifact or the machine payload — nothing else, ever.** Progress, warnings, and errors go to stderr, including in `--json` mode.

- Conversions write the output file and print its **absolute path** to stdout — `OUT=$(enconvert convert a.docx --to pdf)` just works, and `enconvert convert *.docx --to pdf | wc -l` counts results.
- `-o -` is the only way to get raw bytes on stdout (single input only).
- `--json` prints the gateway's response verbatim; `--jq <expr>` filters it with a bundled jq (no jq binary needed); `--jsonl` streams NDJSON for batch commands.
- `--url-only` prints the presigned URL and skips the download.
- Exit codes are documented, stable, and append-only — run `enconvert help exit-codes` or see the [docs](https://enconvert.com/docs/cli/exit-codes). Highlights: `2` usage, `4` auth, `5` rate limited, `6` plan/quota, `9` job failed (with `--exit-status`), `10` network/timeout.

## Commands

| Command | What it does |
|---|---|
| `convert <input...> -t <fmt>` | Any of the 46 file routes, endpoint inferred from extension + `--to` |
| `data` / `compress` / `pdf` / `markdown` | Data-format aliases, image compression, anything-to-pdf, anything-to-markdown |
| `url pdf\|screenshot\|markdown <url...>` | Render URLs (viewport, selectors, cookies, headers, basic auth, PDF geometry) |
| `site pdf\|screenshot <url>` | Crawl a whole site into a ZIP (sitemap/full/auto) |
| `perceive <url>` (+ `get`, `batch`) | Render a page into markdown/HTML/screenshot/PDF/links + structured extraction |
| `discover <url>` | Enumerate a site's URLs — sitemap, crawl, or hybrid |
| `lookup <query>` | Web search with optional enrichment and answer synthesis |
| `distill <url...>` | Schema- or prompt-driven structured extraction |
| `ingest ...` | Site → RAG-ready chunked JSONL (create/files/list/get/cancel/webhook-secret) |
| `jobs get\|batch\|wait` | Poll any job or batch; `wait` auto-detects the id kind |
| `files download <object-key>` | Fetch a stored artifact |
| `formats` / `params` | The conversion matrix and per-route options |
| `whoami` / `status` / `usage` | Identity, API health, quota |
| `auth` / `config` | Login, logout, profiles, resolved-config debugging |
| `api <path>` | Raw passthrough to **every** endpoint, `gh api`-style (`-f`, `-F`, `--input`, `--paginate`) |
| `completion <shell>` | bash, zsh, fish, PowerShell completions |
| `upgrade` / `docs` / `mcp install` | Self-update, docs search, MCP server install |

Every command supports `-h/--help`; `enconvert help exit-codes|environment|formatting` covers the cross-cutting topics.

## Configuration & profiles

Config lives at `~/.config/enconvert/config.toml` (`%APPDATA%\enconvert` on Windows), credentials in a `0600` `credentials.toml` next to it. Precedence for every setting: **flag → env → project `.enconvertrc.toml` → user → system → default** — `enconvert config debug` prints each resolved value and where it came from.

```toml
default_profile = "default"

[profile.default]
api_url     = "https://api.enconvert.com"
color       = "auto"
concurrency = 8

[profile.staging]
api_url = "https://api-staging.enconvert.com"

[profile.ci]
credential_helper = "op read op://eng/enconvert/api-key"
```

Select a profile with `-p/--profile` or `ENCONVERT_PROFILE`.

## CI usage

```yaml
- name: Convert release notes to PDF
  env:
    ENCONVERT_API_KEY: ${{ secrets.ENCONVERT_API_KEY }}
  run: |
    npm i -g @enconvert/cli     # or: curl -fsSL https://get.enconvert.com/install.sh | sh
    enconvert convert CHANGELOG.md --to pdf -o notes.pdf
    enconvert url screenshot https://staging.example.com --exit-status
```

In CI the CLI auto-disables colour, progress bars, prompts, and the update check.

## Telemetry: none

**This CLI makes no requests except the API calls you ask for and a once-daily version check** against a static file (`ENCONVERT_NO_UPDATE_NOTIFIER=1` disables it). No analytics, no crash reporting, no phone-home.

## Uninstall

| Channel | Command |
|---|---|
| Homebrew | `brew uninstall enconvert` (add `--zap` to remove config/cache/state) |
| Scoop | `scoop uninstall enconvert` |
| npm | `npm uninstall -g @enconvert/cli` |
| Shell installer | `rm -rf ~/.enconvert` (Windows: delete `%LOCALAPPDATA%\enconvert`) |

Config, credentials, cache and state live under `~/.config/enconvert`, `~/.cache/enconvert` and `~/.local/state/enconvert` — remove those too for a clean sweep.

## Contributing & license

Issues and PRs welcome at [enconvert/cli](https://github.com/enconvert/cli). Licensed under [MIT](./LICENSE); bundled third-party licenses are listed in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

## Links

- **Docs** — https://enconvert.com/docs/cli
- **Dashboard / API keys** — https://enconvert.com/dashboard
- **MCP server** — https://www.npmjs.com/package/@enconvert/mcp
- **Node SDK** — https://www.npmjs.com/package/@enconvert/node-sdk
- **Issues** — https://github.com/enconvert/cli/issues
