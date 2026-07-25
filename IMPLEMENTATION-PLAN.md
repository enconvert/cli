# Enconvert CLI — Implementation Plan

## Context

Enconvert exposes a large HTTP API (`api.enconvert.com`) with ~75 routes across v1 (file/URL conversion) and v2 (web data: perceive, discover, lookup, distill, ingest, watch). Today the only first-party clients are `@enconvert/node-sdk` (a library, no binary) and `@enconvert/mcp` (an MCP server for AI agents). There is **no terminal surface** — a developer who wants to convert a file or scrape a page from a shell script has to hand-roll `curl` with `X-API-Key`, parse the JSON envelope, and fetch a presigned URL themselves.

`dev/cli/` is an empty directory reserved for this. The goal is a **thin, MIT-licensed, open-source CLI** named `enconvert` that:

- contains **zero conversion logic** — it only makes HTTP calls to the gateway, exactly like the SDKs
- covers **every v1 endpoint and every v2 endpoint except `/v2/watch`**, with all parameters and options
- installs **natively** (Homebrew, Scoop, Winget, `curl | sh`, npm) rather than only via npm
- behaves like a first-class modern CLI: `--help` everywhere, `--json`, shell completion, exit codes, profiles, `--wait` for async jobs

Competitive read: CloudConvert is the only serious file-conversion CLI and it has no auth flow beyond an env var, no profiles, no `--wait`, no raw passthrough, no completion. Every HTML→PDF API (api2pdf, pdfshift, urlbox, browserless) has **no CLI at all**. Firecrawl is the only web-data CLI with modern ergonomics. A single CLI covering both halves with `gh`-grade plumbing has no incumbent.

### Decisions already made (do not relitigate)

| Question | Decision |
|---|---|
| Distribution | **Everything at v1.0** — npm + standalone binaries + Homebrew + Scoop + Winget + `install.sh`/`install.ps1`, all before first public release |
| HTTP layer | **CLI owns a self-contained fetch client** in `src/api/`. Do **not** depend on `@enconvert/node-sdk` at runtime. `--json` emits the gateway's raw response verbatim |
| Endpoint scope | **All working v1 + all v2 except `/v2/watch`.** Excluded from first-class commands: the 5 unimplemented v1 stubs (`thumbnail`, `ocr`, `video`, `speech-to-text`, `text-to-speech` — they 503), `/v1/widget/*`, `/v1/extension/capture`, `/v1/auth/token`, `/v1/auth/branding`, `/internal/*`. All of these remain reachable through `enconvert api` |
| Telemetry | **None.** No PostHog, no phone-home. This is a documented feature in the README |

---

## Ground truth: the API surface being mirrored

Verified directly from `api/gateway/` — this is the contract the CLI must match. **Read `api/gateway/api/v1/convert.py` and `api/gateway/api/v2/schemas/*.py` before writing any request code.**

### Global facts

- **Auth header is `X-API-Key`.** `Authorization: Bearer` is **JWT-only** on this gateway — sending `Bearer sk_...` fails with 401.
- **Never send an `Origin` header with an `sk_` key** → hard 403 (`auth/api_key.py`). Node's `fetch` does not add one; do not add one manually.
- Key format is `sk_<43 urlsafe chars>` / `pk_<43>`, min length 45. **There is no `sk_live_` segment** — existing marketing copy and `mcp/src/cli/validate.ts` say `sk_live_...` illustratively. Client-side validation must be `/^(sk|pk)_/ && length >= 45`.
- Public `pk_` keys reach only `/v1/auth/token` and `/v1/auth/branding`; everything else 403. The CLI is an `sk_` tool.
- Default base URL `https://api.enconvert.com`; local dev is port **8010**.
- Presigned URLs expire in **900 s**. Server request budget is **300 s to first byte** (`middleware/timeout.py`).
- Rate-limit 429 carries `RateLimit-Limit/Remaining/Reset` and `Retry-After`.

### Error envelopes (four distinct shapes — the client must handle all)

1. `{"detail": "<string>"}` — most `HTTPException`s
2. `{"detail": {"error","file_size","max_size","tier","key_type"}}` at **413** from `validate_file_size`
3. `{"detail":[{"loc","msg","type"}]}` — Pydantic **422**
4. `{"error","code","detail","upstream_status"}` — `ConversionError` (codes: `upstream_timeout` 504, `upstream_unreachable` 502, `empty_render` 502, `unsupported_content_type` 415, `selector_not_found` 422)
5. `{"error":"Internal server error","event_id":...}` — unhandled 500

Status semantics used consistently: **402** plan/quota · **403** feature gate / wrong key type · **413** too large · **429** rate limit · **504** timeout.

### V1 endpoints

**System / identity** — `GET /`, `GET /health`, `GET /v1/`, `GET /v1/whoami` (private keys only → `{project_id, plan_slug}`), `GET /v1/auth/verify` (→ `{authenticated, project_id, tier, key_type, allowed_domains, allowed_endpoints}`), `GET /v2/`.

**URL render (JSON body)** — `POST /v1/convert/url-to-pdf`, `/url-to-screenshot`, `/url-to-markdown`. All three share one handler (`utils/processor.handle_url_conversion`) and therefore an **identical body**:

`url` (string or string[]), `job_id`, `async_mode`, `direct_download`, `output_format` (truthy = ZIP), `output_filename`, `notification_email`, `callback_url`, `load_media` (t), `enable_scroll` (t), `handle_sticky_header` (t), `handle_cookies` (t), `wait_for_images` (t), `viewport_width` (1920), `viewport_height` (1080), `wait_for_selector` (≤1000 chars), `wait_for_selector_timeout` (ms, ≤60000), `block_ads` (f), `block_media` (f), `auth {username,password}`, `cookies[]` (≤50, need name+value+(domain|url)), `headers{}` (≤20, blocked: host/content-length/transfer-encoding/connection/upgrade/te/trailer), plus **`single_page` (default true) and `pdf_options` on `url-to-pdf` and `url-to-markdown` only**.

These are the **only** endpoints that stream raw bytes — when `direct_download: true` **and** the key is private. Otherwise JSON `{presigned_url, object_key, filename, file_size, conversion_time_seconds, job_id?}`. Async → **202** `{status, batch_id, url_count, output_format}`.

**Website crawl (JSON, always async → 202)** — `POST /v1/convert/website-to-pdf`, `/website-to-screenshot`. Adds `crawl_mode` (`auto`|`sitemap`|`full`), `include_patterns[]`, `exclude_patterns[]` (full mode only). Returns `{status, batch_id, url_count, total_discovered, discovery_method, output_format}`.

**File upload (multipart) — 46 working routes.** Universal fields on every one: `file` (required), `output_filename`, `direct_download`, `job_id`. **Critical: `direct_download` is inert on all upload routes** — `forward_to_backend` hardcodes `needs_polling = True` (`convert.py:316`), so these *always* return the JSON envelope. The CLI must always parse JSON and fetch the presigned URL.

| Group | Routes | Extra fields |
|---|---|---|
| Data (11) | `json-to-xml`, `xml-to-json`, `json-to-yaml`, `yaml-to-json`, `csv-to-json`, `json-to-csv`, `json-to-toml`, `toml-to-json`, `csv-to-xml`, `xml-to-csv`, `markdown-to-html` | — |
| WeasyPrint (2) | `html-to-pdf`, `markdown-to-pdf` | `pdf_options` (full geometry) |
| LibreOffice (9) | `doc-to-pdf`, `excel-to-pdf`, `ppt-to-pdf`, `odt-to-pdf`, `ods-to-pdf`, `odp-to-pdf`, `ots-to-pdf`, `pages-to-pdf`, `numbers-to-pdf` | `pdf_options` — **grayscale only**, any geometry key → 400 |
| Universal (2) | `anything-to-markdown`, `anything-to-pdf` | `anything-to-pdf` takes `pdf_options` |
| Image (21) | `jpeg-to-png`, `png-to-jpeg`, `jpeg-to-svg`, `jpeg-to-heic`, `heic-to-jpeg`, `jpeg-to-webp`, `webp-to-jpeg`, `png-to-svg`, `png-to-heic`, `heic-to-png`, `png-to-webp`, `webp-to-png`, `svg-to-heic`, `heic-to-svg`, `webp-to-svg`, `heic-to-webp`, `webp-to-heic`, `pdf-to-jpeg`, **`svg-to-jpeg`/`svg-to-png`/`svg-to-webp`** | the three `svg-to-*` take `width`, `height` (int, ≤10000/side, ≤25M px) |
| Compression (1) | `compress-image` | `target_size_kb` (int ≥ 1); output extension = input extension |

`PdfOptions` (`models.py:56`): `page_size` (A0–A6, B0–B5, Letter, Legal, Tabloid, Ledger), `page_width`, `page_height`, `orientation` (portrait|landscape), `margins{top,bottom,left,right}`, `scale` (0.1–2.0), `grayscale`, `header{content ≤2000, height}`, `footer{...}`. Sent as a **JSON string** in multipart, a **nested object** in JSON bodies.

**Polling / download** — `GET /v1/convert/status/{job_id}` (→ `{status:"processing"}` | `{status:"success",presigned_url,object_key}` | `{status:"failed",error}`), `GET /v1/convert/batch/{batch_id}` (private keys only → `BatchStatusResponse` with `items[]`), `GET /v1/convert/download/{object_key:path}` (streams bytes).

### V2 endpoints (watch excluded)

- `POST /v2/perceive` (sync), `GET /v2/perceive/{per_id}`, `POST /v2/perceive/batch` (**200 or 202 — branch on status code, not URL count**), `GET /v2/perceive/batch/{batch_id}`, `DELETE /v2/perceive/batch/{batch_id}`
- `POST /v2/discover`
- `POST /v2/lookup`
- `POST /v2/distill`
- `POST /v2/ingest` (202), `POST /v2/ingest/files` (multipart, 1–200 files, 202), `GET /v2/ingest`, `GET /v2/ingest/{ing_id}`, `DELETE /v2/ingest/{ing_id}`, `POST /v2/ingest/{ing_id}/retry-webhook`, `GET /v2/ingest/webhook-secret`, `POST /v2/ingest/webhook-secret/rotate`

Full parameter tables live in `api/gateway/api/v2/schemas/{perceive,discover,lookup,distill,ingest}.py` — **transcribe them from source, not from memory**. Notable items the existing SDK misses:

- `discover.render_js` (`auto`|`never`|`always`)
- `lookup.enrich` (`{outputs[], concurrency 1–5, schema, synthesize_answer, answer_prompt}`) and response `answer`/`answer_sources`
- `distill.prompt` (≤2000; **at least one of `schema`/`prompt` required**), `distill.css_schema` (recursive `CssField`, depth ≤5), `synthesized_schema` in the response
- `ingest.mode` includes `files`
- `perceive.proxy_url`, `perceive.geolocation`, `perceive.action_chain` parse but **always 422** — do not expose as flags

---

## Architecture

`dev/cli/` is its own git repo (`github.com/enconvert/cli`, public, MIT), matching the `node-sdk` / `mcp` convention. Package `@enconvert/cli`, bin `enconvert`. Both `enconvert` and `@enconvert/cli` are **confirmed available on npm**.

```
cli/
├── src/
│   ├── cli.ts                    # entry: shebang, top-level error boundary, exit-code mapping
│   ├── program.ts                # root Command, global options, preAction hook
│   ├── api/
│   │   ├── http.ts               # fetch core: X-API-Key, UA, timeout, retry+Retry-After, --debug tracing
│   │   ├── errors.ts             # ApiError hierarchy, 4-envelope parser, status → exit code
│   │   ├── v1.ts                 # every /v1 route, raw snake_case JSON in/out
│   │   ├── v2.ts                 # every /v2 route (minus watch), raw JSON in/out
│   │   ├── multipart.ts          # FormData + Blob upload, file-size preflight
│   │   ├── download.ts           # presigned URL → disk/stdout, progress, atomic .tmp+rename
│   │   └── routes.generated.ts   # (from, to) → endpoint table + option-capability matrix
│   ├── commands/
│   │   ├── convert.ts  url.ts  site.ts  data.ts  compress.ts  download.ts
│   │   ├── perceive.ts  discover.ts  lookup.ts  distill.ts  ingest.ts
│   │   ├── jobs.ts  formats.ts  params.ts  usage.ts  status.ts  whoami.ts
│   │   ├── auth.ts  config.ts  api.ts  completion.ts  upgrade.ts  docs.ts  mcp.ts
│   │   └── help-topics.ts        # exit-codes, environment, formatting
│   ├── config/
│   │   ├── paths.ts              # XDG resolution, ENCONVERT_CONFIG_DIR
│   │   ├── config.ts             # TOML load/merge/save, zod schema, profiles
│   │   ├── credentials.ts        # 0600 credentials.toml, credential_helper
│   │   └── resolve.ts            # flag > env > project > user > system > default, w/ provenance
│   ├── output/
│   │   ├── streams.ts            # stdout/stderr discipline, EPIPE guard
│   │   ├── color.ts  progress.ts  table.ts  json.ts  jq.ts  template.ts
│   │   └── errors.ts             # error[EXXX] renderer
│   ├── util/
│   │   ├── tty.ts  files.ts  glob.ts  duration.ts  poll.ts  update-notifier.ts
│   └── version.ts                # single source of truth, injected at build
├── scripts/
│   ├── generate-routes.ts        # OpenAPI → routes.generated.ts + api-index.generated.json
│   └── build-binaries.ts         # bun --compile × 7 targets (or GoReleaser drives it)
├── tests/                        # node:test + undici MockAgent + help snapshots
├── completions/                  # generated at build, shipped in archives
├── .goreleaser.yaml
├── .github/workflows/{ci.yml,release.yml,npm-publish.yml}
├── install.sh  install.ps1
├── package.json  tsconfig.json  tsdown.config.ts
├── README.md  LICENSE (MIT)  CHANGELOG.md  THIRD-PARTY-NOTICES.md
```

### Dependency set

```jsonc
"engines": { "node": ">=22.12.0" },   // commander@15 is ESM-only and requires this
"type": "module",
"bin": { "enconvert": "./dist/enconvert.js" },
"dependencies": {},                   // intentionally empty — everything is bundled
"devDependencies": {
  "commander": "^15.0.0",
  "@commander-js/extra-typings": "^15.0.0",
  "@bomb.sh/tab": "0.0.21",           // EXACT pin — pre-1.0
  "picocolors": "^1.1.1",
  "yocto-spinner": "^1.2.2",
  "@inquirer/prompts": "^8.5.2",
  "zod": "^4.4.3",
  "smol-toml": "^1.7.0",
  "tsdown": "~0.22.14",
  "tsx": "^4.19.0", "typescript": "^5.6.0",
  "undici": "^8.9.0", "publint": "^0.3.0", "@types/node": "^22.0.0"
}
```

Two facts that override the existing repo conventions:

1. **`tsup` is unmaintained** — its README points at `tsdown`. `node-sdk` and `mcp` both use it. The CLI uses **tsdown**; migrating the other two is optional follow-up.
2. **`mcp/package.json` is internally inconsistent**: it declares `engines: "^20.20.0 || >=22.22.0"` while depending on `commander@^15`, which requires `>=22.12.0`. The Node 20 branch will fail at import. Worth fixing, but out of scope here.

Deliberately **not** added: `chalk`, `ora` (8 transitive deps incl. chalk), `boxen`, `cli-table3`, `yargs`, `oclif`, `update-notifier`, `keytar` (archived 2022), `@napi-rs/keyring` (native addon breaks zero-dep + complicates `bun --compile`; no OS keychain in v1).

---

## Command tree

**Philosophy**: verb-first for v1 (it is 46 spellings of one action), **API-name-canonical for v2** (so the CLI reference *is* the API reference), noun groups for resources, and a mandatory `api` passthrough that guarantees 100% coverage.

The 46 upload routes **must not** become 46 subcommands. One `convert` command infers the endpoint from `(input extension | --from, --to)` via `routes.generated.ts`.

```
enconvert <file...> --to <fmt>          # shorthand for `convert` (--to disambiguates)
enconvert <url>                         # exit 2 + a 4-line menu; never guess a metered action

# ── v1: file conversion ──────────────────────────────────────────────
convert <input...> -t <fmt> [--from <fmt>] [--endpoint <name>]
        [-o <file>|-] [-O <dir>] [-F] [--skip-existing] [--url-only]
        [--output-filename <name>] [--job-id <id>]
        [--pdf-page-size A4] [--pdf-orientation portrait|landscape]
        [--pdf-margin <t,r,b,l>] [--pdf-scale 1.0] [--pdf-grayscale]
        [--pdf-header <html>] [--pdf-footer <html>]
        [--pdf-header-height 15] [--pdf-footer-height 15]
        [--pdf-page-width <mm>] [--pdf-page-height <mm>]
        [--width <px>] [--height <px>]            # svg-to-{jpeg,png,webp} only
data <input...> -t json|xml|yaml|csv|toml|html    # alias into the 11 data routes
compress <file...> [--target-size-kb <n>]
pdf <file...>                                     # anything-to-pdf
markdown <file...>                                # anything-to-markdown

# ── v1: URL / site render ────────────────────────────────────────────
url pdf <url...>          [render flags] [pdf flags] [--single-page/--no-single-page]
url screenshot <url...>   [render flags]
url markdown <url...>     [render flags] [pdf flags] [--single-page/--no-single-page]
site pdf <url>            [--crawl-mode auto|sitemap|full] [--include-pattern <re>...]
site screenshot <url>     [--exclude-pattern <re>...] [auth/cookie/header flags]

# render flags (shared by all url/site commands, 1:1 with the JSON body):
#   --viewport-width --viewport-height --wait-for-selector --wait-for-selector-timeout
#   --load-media/--no-load-media --enable-scroll/--no-enable-scroll
#   --sticky-header/--no-sticky-header --handle-cookies/--no-handle-cookies
#   --wait-for-images/--no-wait-for-images --block-ads --block-media
#   --basic-auth user:pass  --cookie 'name=value;domain=...'  --header 'K: V'
#   --async/--no-async --zip --notification-email --callback-url --output-filename --job-id

# ── v2: web data ─────────────────────────────────────────────────────
perceive <url>            [--output markdown,html_cleaned,screenshot,pdf,links,images,structured,...]
                          [--extract tables,metadata,main_content,headings,structured_data]
                          [--schema-file s.json] [--wait-for <sel|js:...>] [--wait-timeout-ms 30000]
                          [--js-code <src>|@file] [--viewport WxH] [--mobile] [--respect-robots]
                          [--cache-mode enabled|bypass|refresh] [--block-resource image,font,...]
                          [--header 'K: V'] [--cookie ...] [--basic-auth user:pass] [pdf flags]
                          [-O <dir>] [--url-only]
perceive get <per_id>
perceive batch <url...>   [--input-file urls.txt] [--output-mode manifest|zip] [+ all perceive flags]
                          [--wait/--no-wait] [--jsonl]
perceive batch get <batch_id>
perceive batch cancel <batch_id>
discover <url>            [--mode sitemap|crawl|hybrid] [--max-urls 100] [--max-depth 2]
                          [--include-pattern <re>...] [--exclude-pattern <re>...]
                          [--same-domain-only/--no-same-domain-only] [--respect-robots]
                          [--render-js auto|never|always]
lookup <query>            [--category web|news|images|scholar|patents|maps] [--country] [--locale]
                          [--time-filter hour|day|week|month|year] [--num-results 10] [--page 1]
                          [--location] [--no-autocorrect] [--perceive-top 0]
                          [--enrich-output markdown,...] [--enrich-concurrency 3]
                          [--enrich-schema-file s.json] [--synthesize-answer] [--answer-prompt <p>]
distill <url...>          [--discover-from <url> --discover-mode <m> --discover-max-pages 10]
                          --schema-file s.json | --prompt "<p>"
                          [--css-schema-file c.json] [--wait-for] [--wait-timeout-ms]
                          [--header] [--cookie] [--respect-robots]
ingest create <url|--url-file f> [--mode urls|sitemap|crawl] [--max-pages] [--max-depth]
                          [--include-pattern] [--exclude-pattern] [--same-domain-only]
                          [--respect-robots] [--wait-for] [--wait-timeout-ms]
                          [--chunk-max-words 512] [--chunk-sentence-overlap 1]
                          [--webhook-url] [--wait/--no-wait]
ingest files <path...>    [--max-words 512] [--sentence-overlap 1] [--webhook-url] [--wait]
ingest list               [--skip 0] [--limit 20]
ingest get <ing_id>
ingest cancel <ing_id>
ingest retry-webhook <ing_id>
ingest webhook-secret show | rotate

# ── resources & meta ─────────────────────────────────────────────────
jobs get <job_id>         # GET /v1/convert/status/{id}
jobs batch <batch_id>     # GET /v1/convert/batch/{id}
jobs wait <id>            [--poll-interval 3] [--wait-timeout 15m] [--exit-status] [--json]
files download <object-key> [-o <path>|-]
formats                   [--from <fmt>] [--to <fmt>] [--json]
params convert            --from <fmt> --to <fmt> [--json]
whoami | status | usage
auth login|logout|status|token|switch     (+ top-level `login`/`logout` aliases)
config get|set|unset|list|edit|path|debug
api <path>                [gh-compatible flags — see below]
completion bash|zsh|fish|powershell [install]
version | upgrade | docs [query] | open [dashboard|billing|docs]
mcp install <claude|cursor|codex|windsurf|vscode|zed|gemini|opencode>
help [command] | help exit-codes | help environment | help formatting
```

**Aliases** (hidden in help, present for muscle memory): `scrape`→`perceive`, `map`→`discover`, `search`→`lookup`, `extract`→`distill`, `screenshot`→`url screenshot`.

**Reserve the name `watch`.** Do not let anything else claim it — `/v2/watch` is deliberately out of scope now and will want it later.

### `enconvert api` — the coverage guarantee

This is what makes "mirror ALL endpoints" literally true. `/v1/auth/token`, `/v1/auth/refresh`, `/v1/auth/branding`, `/v1/widget/{id}/*`, `/v1/extension/capture`, and the five 503 stubs are integration surfaces nobody types at a prompt — they are reachable here with full fidelity, and every future gateway endpoint works on the day it ships with no CLI release.

Copy `gh api`'s flag vocabulary exactly (it is the one users already know):

```
enconvert api /v2/perceive -f url=https://example.com -F mobile=true
enconvert api /v1/whoami --jq .plan_slug
enconvert api /v2/ingest --input body.json
enconvert api /v1/convert/anything-to-pdf -F file=@report.docx -f direct_download=false

  -X, --method <M>        GET by default; auto-POST when a field flag is present
  -f, --raw-field k=v     always a string
  -F, --field k=v         magic typing: true/false/null/int → JSON; @file / @- reads file/stdin
                          nested via k[sub]=v, arrays via k[]=v
  -H, --header 'K: V'
      --input <FILE|->    pre-built JSON body (field flags become query params)
      --paginate  --slurp
  -q, --jq <expr>   -t, --template <tmpl>   -i, --include   --silent
      --list-endpoints    from api-index.generated.json
      --search <q>
      --describe <path>
```

**Flag-collision ruling**: `-f` and `-F` mean `--raw-field`/`--field` **inside `api` only**. Globally, force is `-F, --force` and target format is `-t, --to`. Document the exception in `enconvert api --help`.

---

## Global flags, env vars, exit codes

```
  -h, --help                     root + every subcommand; never overloaded
  -V, --version                  (-v is verbose, per 12-factor CLI)
  -v, --verbose                  diagnostics to stderr; repeatable (-vv)
      --debug                    stack traces + HTTP tracing (env ENCONVERT_DEBUG=api)
  -q, --quiet                    suppress non-essential stderr; errors still shown

  -o, --output <path>            output file, or "-" for stdout
  -O, --output-dir <dir>         output directory for multi-file results
      --json                     one JSON document on stdout
      --jsonl                    NDJSON stream (batch, discover, ingest, jobs)
      --jq <expr>                filter JSON (jq bundled — no jq binary needed)
      --template <go-tmpl>
      --color <auto|always|never>   --no-color
      --no-progress

  -y, --yes                      assume yes
  -F, --force                    overwrite / skip safety checks
      --skip-existing
  -n, --dry-run                  describe without executing, without spending quota
      --no-input                 never prompt; fail if a required value is missing

      --config <path>            (env ENCONVERT_CONFIG)
  -p, --profile <name>           (env ENCONVERT_PROFILE)
      --api-key <key|@file|->    @file reads a file, - reads stdin
      --api-url <url>            (env ENCONVERT_API_URL)
      --timeout <dur>            per-HTTP-request, default 120s
      --retries <n>              idempotent requests only, default 2
  -j, --concurrency <n>          default min(cpus, 8)
      --                         stop flag parsing
```

On every job-producing command: `--wait`/`--no-wait` (default `--wait`), `--poll-interval <s>` (3), `--wait-timeout <dur>` (15m), `--exit-status`, `--url-only`.

**`--timeout` ≠ `--wait-timeout`.** One is a single HTTP request; the other is how long you block on a queued job. Never conflate them.

Env vars, published as `enconvert help environment`:
`ENCONVERT_API_KEY`, `ENCONVERT_API_URL`, `ENCONVERT_PROFILE`, `ENCONVERT_CONFIG`, `ENCONVERT_CONFIG_DIR`, `ENCONVERT_DEBUG`, `ENCONVERT_NO_INPUT`, `ENCONVERT_NO_UPDATE_NOTIFIER`, `ENCONVERT_INSTALL`, `ENCONVERT_VERSION`, plus `NO_COLOR`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `TERM`, `CI`, `PAGER`, `TMPDIR`, `DO_NOT_TRACK`, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`.

Exit codes, published as `enconvert help exit-codes`, append-only forever, one test each:

| Code | Meaning | Trigger |
|---|---|---|
| 0 | Success | — (also: EPIPE — exit 0 silently, never a stack trace) |
| 1 | Generic failure | Unclassified |
| 2 | Usage error | Bad flag, missing arg, unknown subcommand, `--no-input` with a missing value, `-o -` with multiple inputs |
| 3 | Input not found | ENOENT, EACCES, empty glob |
| 4 | Auth required/invalid | 401 |
| 5 | Rate limited | 429 — message carries `Retry-After` |
| 6 | Plan gate / quota | 402, and 403 feature gates |
| 7 | Unsupported conversion | client-side matrix miss, or 415 |
| 8 | Input rejected | 413, MIME/magic-byte mismatch, 400 on a file field |
| 9 | Server-side failure | 5xx from a converter, or job `status: failed` under `--exit-status` |
| 10 | Network / timeout | DNS, connect, TLS, request timeout, 504 |
| 130 | SIGINT | Ctrl-C |

**Commander exits 1 on usage errors; we want 2.** Use `.exitOverride()` and remap `commander.unknownOption` / `unknownCommand` / `missingArgument` / `excessArguments` → 2, and `commander.help` / `commander.version` → 0.

---

## Output contract

**stdout = the artifact or the machine payload. Nothing else, ever. stderr = everything else — progress, spinners, warnings, errors, `--verbose`, the update nag — including in `--json` mode.**

The binary rule (the single most consequential behavioral decision):

| Situation | Behaviour |
|---|---|
| No `-o`, stdout is a TTY | Write to a derived filename (`report.docx` → `report.pdf`), print the **absolute path** to stdout |
| No `-o`, stdout is a pipe/file | **Identical** — write to disk, print the path. Do **not** stream bytes |
| `-o <path>` | Write there, print the path |
| `-o -` | The **only** way to get bytes on stdout. Single input only; multiple → exit 2 |
| `-O <dir>` | One path per line on stdout |
| `--url-only` | Print the presigned URL, skip the download |

Rationale: the gateway returns **presigned URLs, not bytes**, on every upload route, and this CLI is batch-capable. `enconvert convert *.docx --to pdf | wc -l` must count paths. Path-on-stdout also makes `OUT=$(enconvert convert a.docx --to pdf)` work.

For `-o -`: write `Buffer`s via `process.stdout.write()`, never set an encoding, await drain via `stream.pipeline`, and install the EPIPE guard **before the first byte**:
```ts
process.stdout.on("error", (e) => { if ((e as NodeJS.ErrnoException).code === "EPIPE") process.exit(0); throw e; });
```

`--json`: exactly one parseable document, **byte-identical piped or on a TTY**, zero ANSI. Errors still go to stderr as text. Field names are API the moment they ship — add, never rename. `--jsonl` is compact, `\n`-terminated, flushed per record, with a stable `type` discriminator. Progress in JSON mode, if any, is NDJSON on **stderr**.

Colour resolution, highest → lowest: `--color`/`--no-color` → `FORCE_COLOR` (`=0` off, other non-empty on) → `NO_COLOR` (present **and non-empty**; `NO_COLOR=""` does **not** disable) → `CLICOLOR_FORCE`/`CLICOLOR` → config `color` → auto (`stderr.isTTY && TERM!=="dumb" && !CI`). Gate on **`process.stderr.isTTY`**, not stdout, and always `Boolean()`-coerce (`isTTY` is `undefined`, not `false`, when detached).

Progress: first output within 100 ms; suppress when any of `!stderr.isTTY`, `CI`, `--quiet`, `--json`, `--jsonl`, `--no-progress`, `TERM=dumb`, or expected < 500 ms. **Degrade, don't disappear** — non-TTY emits `converting 19/40 report.pdf` lines. On SIGINT: stop the renderer, restore the cursor (`\x1b[?25h` in a `finally` *and* on `SIGINT`/`exit`), delete the partial output (write `.tmp` + atomic rename), exit 130 within ~1 s.

Error format — every error answers what/why/what-next:
```
error[E006]: plan quota exhausted

    10,000 conversions/month on the Pro plan; used 10,000.
    quota resets 2026-08-01.

    help: upgrade at https://enconvert.com/pricing
          or run `enconvert usage --json` for the breakdown
    docs: https://enconvert.com/docs/errors/E006
```
Rewrite HTTP errors for humans (never `APIError: [413] ...`); stack traces only under `--debug`; most important info last; group repeated failures under a header; Levenshtein suggestions for mistyped subcommands and format names (*suggest*, never auto-execute).

---

## Auth & config

Precedence, identical for every setting: **flag → env → project (`./.enconvertrc.toml`, walking up) → user (`$XDG_CONFIG_HOME/enconvert/config.toml`) → system (`/etc/enconvert/config.toml`) → default.** `enconvert config debug` prints every resolved value **and its source** — Commander's `getOptionValueSource()` gives this nearly free and it is the highest-leverage support-deflection command after `usage`.

| Platform | Config | Credentials | Cache | State |
|---|---|---|---|---|
| macOS & Linux | `~/.config/enconvert/config.toml` | `~/.config/enconvert/credentials.toml` (**0600**, dir 0700) | `~/.cache/enconvert/` | `~/.local/state/enconvert/` |
| Windows | `%APPDATA%\enconvert\config.toml` | `%APPDATA%\enconvert\credentials.toml` | `%LOCALAPPDATA%\enconvert\cache` | same |

`~/.config` on macOS, **not** `~/Library/Application Support` — gh, stripe, kubectl, docker, terraform, git and `op` all do this. Honour `XDG_*_HOME` (ignore relative values; unset *or empty* → default). `ENCONVERT_CONFIG_DIR` overrides the whole tree. **Read-migrate from `~/.enconvert/config.json`** — `@enconvert/mcp` already writes there (`mcp/src/cli/credentials.ts`), and a user who ran `npx @enconvert/mcp setup` should not have to paste their key again.

TOML via `smol-toml`, validated with zod (`z.prettifyError` for messages). Profiles use the AWS/Stripe model:

```toml
default_profile = "default"

[profile.default]
api_url        = "https://api.enconvert.com"
color          = "auto"
concurrency    = 8

[profile.staging]
api_url = "https://api-staging.enconvert.com"

[profile.ci]
credential_helper = "op read op://eng/enconvert/api-key"
```

`-p/--profile` always wins, then `ENCONVERT_PROFILE`, then `default_profile`. **No stored "current profile" in v1** — invisible statefulness is how kubectl-context accidents happen.

Credential read chain: `--api-key <value|@file|->` → `ENCONVERT_API_KEY` → `credential_helper` command in config → `credentials.toml`. **No OS keychain in v1** — a native `.node` addon breaks the zero-dependency property, complicates `bun --compile` (addons embed only when `require`d directly), and is unavailable in exactly the environments this CLI runs in (containers, CI, WSL, SSH). `credential_helper` is 10 lines and unlocks 1Password/pass/Vault/SOPS instead.

`enconvert auth login`: `--with-token` reads from **stdin, never argv** (argv leaks to `ps` and shell history); `--browserless` for SSH sessions; interactive path uses `@inquirer/prompts` `password({mask:"*"})`. Validate the key with **`GET /v1/whoami`** — better than the MCP's `GET /v2/watch?limit=1` because it returns `{project_id, plan_slug}` and is explicitly private-key-only, so 403 cleanly means "that's a public `pk_` key". `auth status` must state **which backend the credential came from** — gh's most-reported confusion is silent fallback. Redact to `sk_…abcd` everywhere, including `--debug`.

Warn once on stderr when a raw `--api-key` value is passed in an interactive session, pointing at `@file` / `-` / the env var.

---

## Async job UX

The gateway's sync/async split is genuinely mixed: most `/v1/convert/*` returns a completed result, `website-to-*` is always 202, `/v2/perceive/batch` returns **200 or 202 depending on server load for the same request**, and `/v2/ingest` is always job-based. Ship all four affordances — most CLIs ship two, and the missing ones are exactly what breaks shell pipelines.

1. **`--wait` (default on)**, with exponential backoff from 1 s → `--poll-interval` (3 s), capped at 10 s, full jitter. A fixed 1 s poll against a metered API is a self-inflicted rate-limit. **Respect `Retry-After` on 429 absolutely.** `--wait-timeout` (15 m) exits 10 and **prints the resume command** — never leave a user without a handle on a running job.
2. **`--no-wait`** prints the id and exits 0. Machine form: `{"job_id":"…","status":"queued","poll":"enconvert jobs wait …"}`.
3. **`enconvert jobs wait <id>`** as a standalone composable command — this is the piece almost every CLI misses and it is what makes `enconvert ingest create ... --no-wait --json | jq -r .job_id | xargs enconvert jobs wait` work. It must auto-detect the id kind from the prefix (`ing_`, `batch_`, `per_`, `dst_`, or a bare v1 `job_id`/`batch_id`) and route to the right poll endpoint.
4. **`--exit-status`** — non-zero (9) when the job itself failed, so `cmd && next` is correct in CI. Never overload with 1.

Client-supplied `job_id` on v1 upload/URL routes is a **crash-recovery handle**: always generate a UUID and send it, so a proxy timeout is recoverable via `GET /v1/convert/status/{job_id}`. Mirror the SDK's fallback (`node-sdk/src/client.ts:postJson`): on a 5xx, switch to polling that id instead of retrying the POST.

---

## Distribution (all channels at v1.0, per the decision)

| Channel | Mechanism |
|---|---|
| npm global + npx | `npm i -g @enconvert/cli` — **single bundled ESM file, zero runtime deps**, published via **npm Trusted Publishing (OIDC)**, no `NODE_AUTH_TOKEN`, provenance automatic |
| GitHub Releases | 7 archives + `enconvert_<ver>_checksums.txt` + `actions/attest-build-provenance@v3` |
| Standalone binaries | `bun build --compile` × 7 targets from **one `ubuntu-latest` runner** |
| Homebrew | **cask** (not formula) in `enconvert/homebrew-tap`, macOS + Linux |
| Scoop | `enconvert/scoop-bucket` with `checkver` + `autoupdate` pointing at `checksums.txt` |
| Winget | `komac` PR into `microsoft/winget-pkgs` |
| `curl \| sh` | `get.enconvert.com/install.sh` + `install.ps1` |

**Build toolchain: `bun build --compile`, orchestrated by GoReleaser v2 with `builder: bun`.** Rejected alternatives, with reasons: Node SEA (stability 1.1; **macOS x64 not a supported target at all**; Alpine unsupported; cross-compiling forces `useCodeCache:false` + `useSnapshot:false`, forfeiting the only two features that make its startup tolerable). `vercel/pkg` (archived Dec 2024). `nexe` (unmaintained). `deno compile` (no musl target). Bun wins on one decisive property: **all 13 targets including `bun-linux-x64-musl` and `bun-linux-arm64-musl` cross-compile from a single Linux runner** — Alpine/Docker CI is a first-class audience for a conversion-API CLI.

Standing build rules — encode these in CI, they are learned-the-hard-way:

```bash
# Pin Bun EXACTLY. oven-sh#29120 (v1.3.12) emitted a truncated darwin-arm64
# SuperBlob → SIGKILL / exit 137 on Apple Silicon.
BUN_NO_CODESIGN_MACHO_BINARY=1 \
  bun build ./src/cli.ts --compile --bytecode --minify \
    --target=bun-darwin-arm64 --outfile dist/enconvert
rcodesign sign dist/enconvert     # Developer ID + notarize, from Linux CI
```

- `--bytecode` on (works with ESM now, ~2× startup win), `--minify` on. Budget **~60–110 MB per platform**, ~20–35 MB gzipped.
- **Always re-sign darwin artifacts.** On arm64 macOS the kernel SIGKILLs any Mach-O without at least an ad-hoc signature — independent of Gatekeeper.
- Use **`rcodesign`** (`indygreg/apple-code-sign-action`) for Developer ID + notarization **from Linux CI**. No Mac runner needed.
- `--windows-icon`/`--windows-version` **cannot be used when cross-compiling**. Accept a plain `.exe`; add a Windows runner later if Winget's SmartScreen validation demands a signed exe.
- **npm ships JS, never binaries.** This CLI is a thin HTTP client — ~250 KB of bundled JS. Pushing a 90 MB Bun binary down an `npx` invocation to replace it is strictly worse on every axis. (Supabase ships 163–210 MB per platform because it carries a Go sidecar; that reasoning does not transfer.)

Use `homebrew_casks:` in GoReleaser, **not** the deprecated `brews:` — Homebrew's own position is that a precompiled upstream binary is cask territory, and Homebrew 5.0/6.0 added Linux cask support for exactly this shape.

**Two launch blockers specific to this org:**

1. **Cloudflare.** Given the 2026-07-16 `api.enconvert.com` incident, **`get.enconvert.com` must be exempted from Bot Fight Mode / Managed Challenge before launch.** A challenged `curl | sh` endpoint pipes an HTML blob into the user's shell.
2. **Homebrew 6.0 tap trust.** Third-party taps must now be explicitly trusted before evaluation. Test the `brew tap` one-liner against 6.x and show the trust prompt in the README.

`install.sh` spec — copy Deno's shape, add Bun's branches, add checksum verification (the last is the quality delta almost nobody ships): `set -euo pipefail`; `uname -sm` case with an explicit error on unsupported arch; `[ -f /etc/alpine-release ]` → musl target; preflight `tar`/`unzip` check; version pin via positional arg **and** `ENCONVERT_VERSION`; `${ENCONVERT_INSTALL:-$HOME/.enconvert}`; **sha256 verify against `checksums.txt`**; **PATH warning, never silent rc-file mutation** (`-y` to opt in, `--no-modify-path` to opt out); `-h`; `[ -t 1 ]`-gated colour; writes `~/.enconvert/install-method` so `enconvert upgrade` can delegate.

**Update policy — the `gh` model verbatim.** `enconvert upgrade` reads `install-method` and delegates (`brew upgrade` / `scoop update` / `npm i -g` / direct download with sha256 verify + atomic rename). The nag: ≤1 check per 24 h, cached to `~/.local/state/enconvert/`, printed to **stderr after** the command's output, never blocking, and skipped when `CI` is set, `ENCONVERT_NO_UPDATE_NOTIFIER` is set, or **either stdout or stderr is not a TTY**. Serve the "latest" pointer from a static file on `get.enconvert.com` (Deno's trick) rather than the GitHub API — no 60-req/hr unauthenticated limit, works behind corporate proxies. **Never auto-update silently.**

---

## Codegen: `scripts/generate-routes.ts`

The gateway serves FastAPI's default `GET /openapi.json` (no customization — `main.py:126`). The script fetches it (from `ENCONVERT_API_URL` or a local `uvicorn app.main:app --port 8010`) and emits two checked-in artifacts:

1. **`src/api/routes.generated.ts`** — the `(from, to) → endpoint` table, per-endpoint allowed input extensions, and a capability matrix marking which endpoints accept `pdf_options` (and whether geometry is allowed vs grayscale-only), `width`/`height`, or `target_size_kb`. Seed it from `CONVERTER_MAP` in `api/gateway/api/v1/convert.py` and `utils/validators.ALLOWED_EXTENSIONS`, cross-checked against the OpenAPI paths.
2. **`src/api/api-index.generated.json`** — path + method + summary + parameter names, powering `enconvert api --list-endpoints|--search|--describe`.

Check both in, regenerate via `npm run gen:routes`, and add a **CI drift check** that regenerates against production and fails on a diff. A new format pair then becomes a regenerated table, not new CLI code.

Two gotchas the generator must encode, both real gaps in the gateway:

- `utils/validators.ALLOWED_EXTENSIONS` has entries only for `jpeg-to-png`, `png-to-jpeg`, `jpg-to-svg` (**misnamed** — the route is `jpeg-to-svg`), `svg-to-jpeg`, `svg-to-png`, `svg-to-webp`, `compress-image`. The other image routes have **no server-side extension allowlist**. Mirror this conservatively client-side — derive the expected input extension from the route name.
- The five 503 stubs and the two commented-out routes (`/v1/convert/image`, `/v1/convert/key-to-pdf`) must be marked and excluded from `formats`/`convert` resolution.

---

## Testing

`node:test` (already the house runner in `mcp`; snapshot testing stable since Node 23.4; Commander migrated its own suite to it in v15). **No vitest** — its transform/browser machinery buys nothing for a process-spawning, stdout-capturing, fetch-mocking suite.

HTTP mocking: **`undici` `MockAgent` + `setGlobalDispatcher`**. Node's global `fetch` *is* undici; `nock` is built on `node:http` and does **not** intercept native fetch; `msw` lacks `disableNetConnect()` and `assertNoPendingInterceptors()`, the two calls that make a suite rigorous rather than decorative.

Required suites:

- **Endpoint coverage contract** — assert that every path in `api-index.generated.json` (minus the documented exclusion list) is reachable either by a typed command or by `api`. This is the test that keeps "mirrors the whole API" true over time.
- **Help snapshots** for the root and every command group. `--help` output is a product surface.
- **Exit codes** — one test per documented code that actually provokes it.
- **Output invariants** (from the contract above): `--json` byte-identical piped vs TTY and ANSI-free; `--jsonl` every line parses; binary never reaches a TTY without `-o -`; `NO_COLOR=1` → zero escapes while `NO_COLOR=""` → colour retained; `--color=always` beats `NO_COLOR`; `--no-input` with a missing value errors at 2 and never hangs; `head -c 100` on a large piped output produces no EPIPE trace; cold start `enconvert --version` < 200 ms.
- **Request-shape golden tests** — for each command, assert the exact method, path, headers, and body the CLI sends. This is what proves the 1:1 API mirror, and it is cheap with MockAgent.
- **Config resolution** — the full flag > env > project > user > system > default ladder, including `config debug` provenance.

Use Commander's `.exitOverride()` + `.configureOutput()` so no test needs to monkey-patch `process.stdout`.

---

## Implementation order

Each phase is independently verifiable; do not start a phase before the prior one's checks pass.

**Phase 0 — Scaffold.** `git init` in `dev/cli`, MIT LICENSE (`Copyright (c) 2026 Enconvert`), package.json/tsconfig/tsdown.config, `src/cli.ts` printing help, `enconvert --version`. Check: `npm run build && node dist/enconvert.js --help` works; `publint` clean.

**Phase 1 — Core plumbing.** `src/api/http.ts`, `errors.ts`, `src/config/*`, `src/output/*`, exit-code mapping, colour/TTY/EPIPE handling. Check: the output-invariant tests pass with a stubbed command.

**Phase 2 — Auth + meta.** `auth login/logout/status/token/switch`, `whoami`, `status`, `config *`, `help` topics, `version`. Check: `enconvert auth login --with-token < key.txt && enconvert whoami --json` against production.

**Phase 3 — `api` passthrough + codegen.** `scripts/generate-routes.ts`, `enconvert api` with the full gh flag set, `--list-endpoints`/`--search`/`--describe`. Check: every endpoint in the index is callable; the coverage contract test passes.

**Phase 4 — v1 conversion.** `convert`, `data`, `compress`, `pdf`, `markdown`, `files download`, `jobs *`, `formats`, `params`. Check: round-trip every group (data, WeasyPrint, LibreOffice, image, universal, compress) against production with a real `sk_` key; verify output magic bytes, not just extensions.

**Phase 5 — v1 URL/site.** `url pdf|screenshot|markdown`, `site pdf|screenshot`, async batch polling. Check: `--direct-download` byte streaming on a private key; a 202 → `jobs wait` → downloaded ZIP.

**Phase 6 — v2.** `perceive` (+ batch/get/cancel), `discover`, `lookup`, `distill`, `ingest` (+ files/list/get/cancel/retry-webhook/webhook-secret). Check: request-shape golden tests match the Pydantic schemas field-for-field; `perceive batch` handles both the 200 and 202 branches.

**Phase 7 — Completion + `mcp install`.** `@bomb.sh/tab` wiring, `completion <shell> [install]`. **Hard rule: no network I/O in any completion handler** — format lists come from `routes.generated.ts`. Port `mcp/src/cli/clients.ts` (the 9-client registry) for `enconvert mcp install`.

**Phase 8 — Release engineering.** `.goreleaser.yaml`, the three GH workflows, `install.sh`/`install.ps1`, homebrew-tap and scoop-bucket repos, Winget manifest, `upgrade` + update-notifier, README/CHANGELOG/THIRD-PARTY-NOTICES. Check: a `v0.1.0-rc.1` tag produces all 7 archives + checksums + provenance; `brew install`, `scoop install`, and `curl | sh` each yield a working `enconvert --version` on a clean machine.

---

## Verification

Correctness is proven against the **live gateway**, not mocks, before any tag:

1. `cd cli && npm ci && npm run build && npm run typecheck && npm test` — all green, including the coverage contract and output invariants.
2. Point at a local gateway (`cd api/gateway && source .venv/bin/activate && uvicorn app.main:app --reload --port 8010`, then `--api-url http://localhost:8010`) and exercise every command group. The local run is the safe place to test quota/error paths.
3. Against production with a real `sk_` key, spot-check one endpoint per family and **verify output magic bytes** (`file`/`xxd`), not extensions — `%PDF`, `\x89PNG`, `RIFF....WEBP`, `PK\x03\x04` for ZIP.
4. Error-path matrix: 401 (bad key → exit 4), 402 (a free-plan v2 call → exit 6), 413 (oversized upload → exit 8), 422 (bad `--schema-file` → exit 2), 429 if reachable (→ exit 5, honours `Retry-After`), 504 (a slow render → exit 10).
5. `enconvert convert *.docx --to pdf | wc -l` counts paths; `enconvert convert a.svg --to png -o - | file -` reports PNG; `enconvert perceive <url> --json | jq .operation_id` parses; `enconvert api /v1/whoami --jq .plan_slug` matches `enconvert whoami --json`.
6. Installability on clean machines: macOS arm64 + Linux x64/arm64 + Alpine (musl) + Windows — one per channel (brew, scoop, curl, npm) — each ending in `enconvert --version` and one successful conversion.

**Do not commit or push anything without asking** — every sub-project here is its own repo and Het commits himself.

---

## Appendix: usage syntax (this is the README's Quick Start)

```bash
# Install (any one)
brew install enconvert/tap/enconvert
scoop bucket add enconvert https://github.com/enconvert/scoop-bucket && scoop install enconvert
curl -fsSL https://get.enconvert.com/install.sh | sh
npm i -g @enconvert/cli

# Auth
enconvert auth login                          # interactive, hidden paste
enconvert auth login --with-token < key.txt   # CI-safe: stdin, never argv
export ENCONVERT_API_KEY=sk_...               # or just this
enconvert whoami --json                       # {"project_id":"...","plan_slug":"pro"}

# Convert files — endpoint inferred from extension + --to
enconvert convert report.docx --to pdf                     # → ./report.pdf
enconvert convert *.docx --to pdf -O out/ --skip-existing  # one path per line on stdout
enconvert convert photo.heic --to webp -o thumb.webp
enconvert convert logo.svg --to png --width 1024           # svg-to-png only
enconvert convert diagram.svg --to png -o - | pbcopy       # bytes to stdout
enconvert convert data.json --to yaml                      # the 11 data routes
enconvert compress hero.png --target-size-kb 200
enconvert pdf slides.pptx                                  # anything-to-pdf
enconvert markdown paper.pdf                               # anything-to-markdown
enconvert convert notes.md --to pdf \
  --pdf-page-size Letter --pdf-orientation landscape \
  --pdf-margin 20,15,20,15 --pdf-scale 0.9 --pdf-grayscale
enconvert formats --from heic          # valid targets for HEIC
enconvert params convert --from svg --to png --json

# Render URLs
enconvert url pdf https://example.com --viewport-width 1440 --no-single-page
enconvert url screenshot https://example.com --block-ads --wait-for-selector '#main'
enconvert url markdown https://example.com --url-only
enconvert url pdf https://example.com --basic-auth user:pass --header 'X-Env: staging'
enconvert site pdf https://example.com --crawl-mode sitemap --wait   # 202 → poll → ZIP
enconvert site screenshot https://example.com --no-wait --json | jq -r .batch_id

# V2 web data
enconvert perceive https://example.com --output markdown,links,screenshot -O ./out
enconvert perceive https://example.com --extract tables,metadata --schema-file s.json --json
enconvert perceive batch --input-file urls.txt --output-mode zip --wait --jsonl
enconvert perceive get per_ab12...
enconvert discover https://example.com --mode hybrid --max-urls 500 --render-js always --jsonl
enconvert lookup "best pdf api 2026" --num-results 20 --perceive-top 3 --synthesize-answer
enconvert distill https://a.com https://b.com --schema-file schema.json
enconvert distill --discover-from https://shop.com --discover-max-pages 25 --prompt "product name and price"
enconvert ingest create https://docs.example.com --mode crawl --max-pages 200 \
  --chunk-max-words 512 --webhook-url https://hooks.me/x --no-wait
enconvert ingest files ./docs/*.pdf --max-words 400 --wait
enconvert ingest list --limit 50 --json
enconvert ingest webhook-secret show

# Jobs
enconvert jobs get <job_id>
enconvert jobs wait ing_ab12... --poll-interval 5 --wait-timeout 30m --exit-status
enconvert ingest create https://x.com --no-wait --json | jq -r .job_id | xargs enconvert jobs wait

# Raw API (reaches every endpoint, including ones with no typed command)
enconvert api /v1/whoami --jq .plan_slug
enconvert api /v2/perceive -f url=https://example.com -F mobile=true
enconvert api /v1/convert/anything-to-pdf -F file=@in.docx -f direct_download=false
enconvert api --search perceive
enconvert api --describe /v2/distill

# Meta
enconvert usage --json
enconvert config debug                  # every value + where it came from
enconvert --profile staging perceive https://example.com
enconvert completion zsh > "${fpath[1]}/_enconvert"
enconvert mcp install claude
enconvert help exit-codes
```
