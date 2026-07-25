#!/bin/sh
# enconvert installer — https://enconvert.com/cli
#
#   curl -fsSL https://get.enconvert.com/install.sh | sh
#   curl -fsSL https://get.enconvert.com/install.sh | sh -s -- 1.0.0
#
# Downloads the standalone binary for this platform from GitHub Releases,
# verifies its sha256 against the release checksums file, and installs it to
# ${ENCONVERT_INSTALL:-$HOME/.enconvert}/bin. Never edits shell rc files
# unless -y is given.
#
# POSIX sh on purpose (no bashisms) — this runs under dash, ash/BusyBox
# (Alpine) and macOS /bin/sh alike.
set -eu

REPO="enconvert/cli"
LATEST_URL="https://get.enconvert.com/latest-version"

# ── colours: only when stdout is a terminal and TERM is not dumb ──────────────
if [ -t 1 ] && [ "${TERM:-}" != "dumb" ]; then
  bold="$(printf '\033[1m')"
  red="$(printf '\033[31m')"
  green="$(printf '\033[32m')"
  yellow="$(printf '\033[33m')"
  reset="$(printf '\033[0m')"
else
  bold="" red="" green="" yellow="" reset=""
fi

info() { printf '%s\n' "${green}install${reset}: $*"; }
warn() { printf '%s\n' "${yellow}warning${reset}: $*" >&2; }
fail() {
  printf '%s\n' "${red}error${reset}: $*" >&2
  exit 1
}

usage() {
  cat <<USAGE
${bold}enconvert installer${reset}

Usage: install.sh [options] [version]

  version            install a specific version (e.g. 1.0.0); default: latest
                     (also via ENCONVERT_VERSION)

Options:
  -y                 assume yes: allow the installer to append the PATH line
                     to your shell rc file
  --no-modify-path   never touch rc files, only print the PATH instructions
                     (this is also the default without -y)
  -h, --help         show this help

Environment:
  ENCONVERT_INSTALL  install root (default: \$HOME/.enconvert)
  ENCONVERT_VERSION  version to install (positional argument wins)
USAGE
}

# ── argument parsing ──────────────────────────────────────────────────────────
version="${ENCONVERT_VERSION:-}"
modify_path="no"
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    -y) modify_path="yes" ;;
    --no-modify-path) modify_path="no" ;;
    -*) fail "unknown option: $arg (try --help)" ;;
    *) version="$arg" ;;
  esac
done
# --no-modify-path always wins over -y, whatever the order.
for arg in "$@"; do
  [ "$arg" = "--no-modify-path" ] && modify_path="no"
done

# ── preflight ─────────────────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || fail "curl is required (install curl and re-run)"
command -v tar >/dev/null 2>&1 || fail "tar is required (install tar and re-run)"

# ── platform detection ────────────────────────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os $arch" in
  "Darwin x86_64") target="darwin_x64" ;;
  "Darwin arm64") target="darwin_arm64" ;;
  "Linux x86_64") target="linux_x64" ;;
  "Linux aarch64" | "Linux arm64") target="linux_arm64" ;;
  *)
    fail "unsupported platform: $os $arch
  Supported: macOS (x86_64, arm64), Linux (x86_64, aarch64).
  Windows: use install.ps1, Scoop, or npm i -g @enconvert/cli"
    ;;
esac

# musl detection: Alpine marker file first, then an ldd probe (BusyBox/musl
# ldd prints "musl" in its version banner; glibc prints "GNU libc").
if [ "$os" = "Linux" ]; then
  if [ -f /etc/alpine-release ]; then
    target="${target}_musl"
  elif ldd --version 2>&1 | grep -qi musl; then
    target="${target}_musl"
  fi
fi

# ── resolve version ───────────────────────────────────────────────────────────
if [ -z "$version" ]; then
  # get.enconvert.com serves a plain-text pointer (no GitHub API rate limit,
  # works behind corporate proxies). Fall back to the GitHub releases/latest
  # redirect if that host is unreachable.
  version="$(curl -fsSL --max-time 10 "$LATEST_URL" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -z "$version" ]; then
    redirect="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
    case "$redirect" in
      */v[0-9]*) version="${redirect##*/v}" ;;
      *) version="" ;;
    esac
  fi
  [ -n "$version" ] || fail "could not determine the latest version; pass one explicitly, e.g.  install.sh 1.0.0"
fi
version="${version#v}"

install_root="${ENCONVERT_INSTALL:-$HOME/.enconvert}"
bin_dir="$install_root/bin"
archive="enconvert_${version}_${target}.tar.gz"
base_url="https://github.com/$REPO/releases/download/v$version"

info "installing enconvert $version ($target) to $bin_dir"

# ── download ──────────────────────────────────────────────────────────────────
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

curl -fSL --progress-bar -o "$tmp_dir/$archive" "$base_url/$archive" ||
  fail "download failed: $base_url/$archive
  Does version $version exist? https://github.com/$REPO/releases"
curl -fsSL -o "$tmp_dir/checksums.txt" "$base_url/enconvert_${version}_checksums.txt" ||
  fail "could not download the checksums file — refusing to install unverified binaries"

# ── verify sha256 (hard fail on mismatch) ─────────────────────────────────────
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp_dir/$archive" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp_dir/$archive" | awk '{print $1}')"
else
  fail "neither sha256sum nor shasum found — refusing to install unverified binaries"
fi
expected="$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp_dir/checksums.txt")"
[ -n "$expected" ] || fail "checksums file has no entry for $archive"
if [ "$actual" != "$expected" ]; then
  fail "sha256 mismatch for $archive
  expected: $expected
  actual:   $actual
  The download may be corrupted or tampered with. Not installing."
fi
info "checksum verified"

# ── install ───────────────────────────────────────────────────────────────────
mkdir -p "$bin_dir"
tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
mv -f "$tmp_dir/enconvert" "$bin_dir/enconvert"
chmod +x "$bin_dir/enconvert"
# Ship completions next to the install so users can wire them up later.
if [ -d "$tmp_dir/completions" ]; then
  rm -rf "$install_root/completions"
  mv "$tmp_dir/completions" "$install_root/completions"
fi
# Record how enconvert got here so `enconvert upgrade` can delegate correctly.
printf 'install-script\n' > "$install_root/install-method"

info "installed: $bin_dir/enconvert"

# ── PATH handling: print instructions; append to rc only with -y ──────────────
case ":${PATH}:" in
  *":$bin_dir:"*) on_path="yes" ;;
  *) on_path="no" ;;
esac

if [ "$on_path" = "yes" ]; then
  info "run ${bold}enconvert --help${reset} to get started"
  exit 0
fi

shell_name="$(basename "${SHELL:-sh}")"
case "$shell_name" in
  fish)
    rc_file="$HOME/.config/fish/config.fish"
    path_line="fish_add_path $bin_dir"
    ;;
  zsh)
    rc_file="$HOME/.zshrc"
    path_line="export PATH=\"$bin_dir:\$PATH\""
    ;;
  bash)
    rc_file="$HOME/.bashrc"
    path_line="export PATH=\"$bin_dir:\$PATH\""
    ;;
  *)
    rc_file=""
    path_line="export PATH=\"$bin_dir:\$PATH\""
    ;;
esac

if [ "$modify_path" = "yes" ] && [ -n "$rc_file" ]; then
  # Idempotent: skip when the exact line is already present.
  if [ -f "$rc_file" ] && grep -Fq "$path_line" "$rc_file"; then
    info "PATH line already present in $rc_file"
  else
    printf '\n# Added by the enconvert installer\n%s\n' "$path_line" >> "$rc_file"
    info "added enconvert to PATH in $rc_file — restart your shell or run:"
    printf '  %s\n' "$path_line"
  fi
else
  warn "$bin_dir is not on your PATH"
  printf '\nAdd it by appending this line to %s:\n\n  %s\n\n' "${rc_file:-your shell profile}" "$path_line"
  printf 'Or re-run the installer with -y to have it added for you.\n'
fi
