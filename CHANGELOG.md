# Changelog

All notable changes to the Enconvert CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-06

### Added

- `perceive --full-page` (also on `perceive batch`) sends
  `only_main_content: false` to keep navigation and site chrome; the gateway
  now strips site chrome from `markdown`/`main_content` by default.
- `perceive --direct-download` streams the single requested `--output`
  artifact's bytes as the response body, written to `-o/--output-file`
  (`-` for stdout) or a URL-derived filename.
- The perceive summary line now includes the source page's HTTP status
  (`source status: 404`) and any render-quality `deductions` reported by the
  gateway.

### Removed

- The `markdown_fit` output (gateway removed it) — use `markdown`, which is
  main-content-only by default; opt out with `--full-page`.

## [1.0.0] - 2026-07-25

First public release.

### Added

- **File conversion** — `convert` infers the endpoint from the input extension
  plus `--to`, covering all 46 working `/v1/convert/*` upload routes (data,
  WeasyPrint, LibreOffice, universal, image, compression), with `data`,
  `compress`, `pdf`, and `markdown` shortcuts and full `--pdf-*` geometry flags.
- **URL and site rendering** — `url pdf|screenshot|markdown` and
  `site pdf|screenshot` with the complete render-flag surface (viewport,
  selectors, cookies, headers, basic auth, ad/media blocking, async batches,
  ZIP output).
- **v2 web data** — the full surface minus `/v2/watch`: `perceive`
  (+ `get`/`batch`), `discover`, `lookup` (with enrichment and answer
  synthesis), `distill` (schema, prompt, and CSS-schema modes), and `ingest`
  (create/files/list/get/cancel/retry-webhook/webhook-secret).
- **`api` passthrough** — `gh api`-compatible raw access (`-f`/`-F` fields,
  `--input`, `--paginate`, `--list-endpoints`, `--search`, `--describe`) so
  every gateway endpoint is reachable, including ones without typed commands.
- **Async job UX** — `--wait` (default) with jittered backoff, `--no-wait`,
  composable `jobs wait` with id-kind auto-detection, and `--exit-status` for
  CI pipelines.
- **Auth and config** — `auth login|logout|status|token|switch`, TOML config
  with profiles, `credential_helper` support, project/user/system precedence,
  and `config debug` provenance output.
- **Output contract** — paths on stdout, everything human on stderr, `--json`
  verbatim gateway responses, bundled `--jq`, `--template`, `--jsonl`, and
  documented append-only exit codes.
- **Shell completions** for bash, zsh, fish, and PowerShell; `mcp install` for
  nine MCP clients; `upgrade` that respects the original install channel.
- **Distribution** — npm (`@enconvert/cli`), standalone binaries for
  macOS x64/arm64, Linux x64/arm64 (glibc and musl), and Windows x64, Homebrew
  cask, Scoop bucket, and checksum-verifying `install.sh`/`install.ps1`, all
  with published sha256 checksums and GitHub build provenance.
- **Zero telemetry** — no requests beyond your API calls and a once-daily
  version check (`ENCONVERT_NO_UPDATE_NOTIFIER=1` disables it).

[1.0.0]: https://github.com/enconvert/cli/releases/tag/v1.0.0
