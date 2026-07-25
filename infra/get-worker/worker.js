// get.enconvert.com — Cloudflare Worker serving the CLI installer surface.
//
// Serves exactly three paths, all proxied from the LATEST GitHub release of
// enconvert/cli (assets uploaded by .github/workflows/release.yml):
//
//   /install.sh       POSIX installer  (curl -fsSL https://get.enconvert.com/install.sh | sh)
//   /install.ps1      PowerShell installer (irm https://get.enconvert.com/install.ps1 | iex)
//   /latest-version   bare semver + newline; read by install.sh and the CLI's
//                     once-daily update notifier (src/util/update-notifier.ts)
//
// Zero maintenance: `releases/latest/download/<asset>` always points at the
// newest release, so tagging a release updates what this Worker serves (within
// the 5-minute edge cache TTL). Nothing is deployed to any server.
//
// Bootstrap fallback: before the first release exists, the two scripts are
// proxied from the repo's main branch; /latest-version 404s (both consumers
// handle a non-200 gracefully).
//
// Everything is text/plain + nosniff. If this Worker ever answers with HTML,
// something upstream (a Cloudflare challenge page, a GitHub error page) is
// being piped into user shells — that must fail loudly, hence the explicit
// content-type check on upstream responses.

const REPO = "enconvert/cli";
const CACHE_TTL_SECONDS = 300;

const BASE_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
};

const SERVED_PATHS = new Set(["/install.sh", "/install.ps1", "/latest-version"]);

function upstreamsFor(path) {
  const fromLatestRelease = `https://github.com/${REPO}/releases/latest/download${path}`;
  if (path === "/latest-version") {
    // The version pointer only exists as a release asset — main has no copy on
    // purpose (the tag is the single source of truth for "latest").
    return [fromLatestRelease];
  }
  return [fromLatestRelease, `https://raw.githubusercontent.com/${REPO}/main${path}`];
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405, headers: BASE_HEADERS });
    }
    if (pathname === "/") {
      return Response.redirect("https://enconvert.com/integrations/cli", 302);
    }
    if (!SERVED_PATHS.has(pathname)) {
      return new Response("not found\n", { status: 404, headers: BASE_HEADERS });
    }

    for (const upstream of upstreamsFor(pathname)) {
      const res = await fetch(upstream, {
        redirect: "follow",
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
      });
      if (!res.ok) continue;
      // A release asset / raw file is never HTML; an HTML body here means an
      // upstream error or challenge page. Never pipe that into a shell.
      const upstreamType = res.headers.get("content-type") ?? "";
      if (upstreamType.includes("text/html")) continue;
      const headers = new Headers(BASE_HEADERS);
      headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}`);
      return new Response(request.method === "HEAD" ? null : res.body, { status: 200, headers });
    }
    return new Response("not available yet (no release published)\n", {
      status: 404,
      headers: BASE_HEADERS,
    });
  },
};
