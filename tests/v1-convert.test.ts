// Request-shape goldens for the v1 upload conversion commands (convert /
// compress aliases) against the mock gateway, plus the response-envelope
// handling contract (download, --url-only, -o -, --skip-existing, --json,
// 5xx -> status-poll fallback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  field,
  parseMultipart,
  runCli,
  scratchDir,
  startMockGateway,
  TEST_KEY,
  type MockGateway,
  type MultipartField,
} from "./helpers/harness.js";

/** Multipart fields of the recorded request at `index`. */
function multipartOf(gw: MockGateway, index = 0): MultipartField[] {
  const req = gw.requests[index];
  assert.ok(req !== undefined, `expected a recorded request at index ${index}`);
  return parseMultipart(req.body, String(req.headers["content-type"]));
}

/**
 * Register a conversion route that echoes the uploaded job_id back in the
 * envelope (the real gateway always includes job_id on upload conversions).
 */
function routeEnvelope(gw: MockGateway, endpoint: string, presignedPath: string, filename: string): void {
  gw.route(`POST ${endpoint}`, (req, res) => {
    const fields = parseMultipart(req.body, String(req.headers["content-type"]));
    const jobId = field(fields, "job_id")?.value.toString("utf8") ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        presigned_url: `${gw.url}${presignedPath}`,
        object_key: `prod/files/proj_1/${filename}`,
        filename,
        file_size: 11,
        conversion_time_seconds: 0.42,
        job_id: jobId,
      }),
    );
  });
}

function servePresigned(gw: MockGateway, path: string, bytes: string): void {
  gw.route(`GET ${path}`, (_req, res) => {
    res.writeHead(200, { "content-type": "application/pdf", "content-length": String(bytes.length) });
    res.end(bytes);
  });
}

test("test_docx_to_pdf_posts_multipart_with_generated_job_id_and_no_pdf_options", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");
    routeEnvelope(gw, "/v1/convert/doc-to-pdf", "/presigned/report.pdf", "report.pdf");

    const r = await runCli(["convert", "report.docx", "--to", "pdf", "--url-only"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests.length, 1);
    const req = gw.requests[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/v1/convert/doc-to-pdf");
    assert.equal(req.headers["x-api-key"], TEST_KEY);

    const fields = multipartOf(gw);
    const file = field(fields, "file");
    assert.ok(file !== undefined, "multipart must carry a file part");
    assert.equal(file.filename, "report.docx", "input filename must be preserved");
    assert.equal(file.value.toString("utf8"), "docx-content");
    assert.equal(field(fields, "direct_download")?.value.toString("utf8"), "false");
    const jobId = field(fields, "job_id")?.value.toString("utf8");
    assert.ok(jobId !== undefined, "a job_id must always be generated");
    assert.match(jobId, /^[0-9a-f]{32}$/, "generated job_id is a dashless uuid");
    assert.equal(field(fields, "pdf_options"), undefined, "no pdf_options when no --pdf-* flag was set");
    assert.equal(field(fields, "width"), undefined);
    assert.equal(field(fields, "height"), undefined);
    assert.equal(field(fields, "target_size_kb"), undefined);
  } finally {
    await gw.close();
  }
});

test("test_markdown_to_pdf_all_pdf_flags_serialize_to_exact_pdf_options_json_string", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "notes.md"), "# notes");
    routeEnvelope(gw, "/v1/convert/markdown-to-pdf", "/presigned/notes.pdf", "notes.pdf");

    const r = await runCli(
      [
        "convert", "notes.md", "--to", "pdf", "--url-only",
        "--pdf-page-size", "Letter",
        "--pdf-orientation", "landscape",
        "--pdf-margin", "20,15,10,5",
        "--pdf-scale", "1.5",
        "--pdf-grayscale",
        "--pdf-header", "<b>H</b>",
        "--pdf-header-height", "18",
        "--pdf-footer", "<i>F</i>",
        "--pdf-footer-height", "9",
        "--pdf-page-width", "210",
        "--pdf-page-height", "297",
      ],
      { home, env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]?.path, "/v1/convert/markdown-to-pdf");
    const fields = multipartOf(gw);
    const raw = field(fields, "pdf_options");
    assert.ok(raw !== undefined, "pdf_options must be sent");
    assert.equal(raw.filename, undefined, "pdf_options is a plain form field (a JSON string), not a file part");
    const parsed: unknown = JSON.parse(raw.value.toString("utf8"));
    assert.deepEqual(parsed, {
      page_size: "Letter",
      page_width: 210,
      page_height: 297,
      orientation: "landscape",
      // --pdf-margin t,r,b,l order maps positionally onto the named keys.
      margins: { top: 20, right: 15, bottom: 10, left: 5 },
      scale: 1.5,
      grayscale: true,
      header: { content: "<b>H</b>", height: 18 },
      footer: { content: "<i>F</i>", height: 9 },
    });
  } finally {
    await gw.close();
  }
});

test("test_svg_to_png_sends_width_and_height_form_fields", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "logo.svg"), "<svg/>");
    routeEnvelope(gw, "/v1/convert/svg-to-png", "/presigned/logo.png", "logo.png");

    const r = await runCli(
      ["convert", "logo.svg", "--to", "png", "--width", "1024", "--height", "512", "--url-only"],
      { home, env: { ENCONVERT_API_URL: gw.url } },
    );

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]?.path, "/v1/convert/svg-to-png");
    const fields = multipartOf(gw);
    assert.equal(field(fields, "width")?.value.toString("utf8"), "1024");
    assert.equal(field(fields, "height")?.value.toString("utf8"), "512");
  } finally {
    await gw.close();
  }
});

test("test_compress_sends_target_size_kb_and_output_keeps_input_extension", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "hero.png"), "png-bytes");
    routeEnvelope(gw, "/v1/convert/compress-image", "/presigned/hero.png", "hero.png");
    servePresigned(gw, "/presigned/hero.png", "small-png");

    const r = await runCli(["compress", "hero.png", "--target-size-kb", "200", "-O", "out"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests[0]?.path, "/v1/convert/compress-image");
    const fields = multipartOf(gw);
    assert.equal(field(fields, "target_size_kb")?.value.toString("utf8"), "200");
    // The output name keeps the .png input extension (compress-image is same-as-input).
    const printed = r.stdout.trim();
    assert.ok(printed.endsWith(join("out", "hero.png")), `expected .../out/hero.png, got ${printed}`);
    assert.equal(readFileSync(printed, "utf8"), "small-png");
  } finally {
    await gw.close();
  }
});

test("test_doc_to_pdf_with_pdf_page_size_fails_client_side_exit_7_without_any_request", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");

    const r = await runCli(["convert", "report.docx", "--to", "pdf", "--pdf-page-size", "A4"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 7, `expected exit 7, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /--pdf-grayscale/, "the error should explain grayscale-only routes");
    assert.equal(gw.requests.length, 0, "grayscale-only enforcement must not spend quota");
  } finally {
    await gw.close();
  }
});

test("test_unsupported_conversion_pair_exits_7_offline", async () => {
  const home = scratchDir();
  writeFileSync(join(home, "report.docx"), "docx-content");
  // Dead API URL: any accidental HTTP attempt would surface as exit 10, not 7.
  const r = await runCli(["convert", "report.docx", "--to", "png"], {
    home,
    env: { ENCONVERT_API_URL: "http://127.0.0.1:9" },
  });
  assert.equal(r.code, 7, `expected exit 7, got ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /no conversion from \.docx to png/);
});

test("test_sync_envelope_is_downloaded_and_an_existing_absolute_path_is_printed", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");
    routeEnvelope(gw, "/v1/convert/doc-to-pdf", "/presigned/report.pdf", "report.pdf");
    servePresigned(gw, "/presigned/report.pdf", "%PDF-1.4 converted");

    const r = await runCli(["convert", "report.docx", "--to", "pdf"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    const printed = r.stdout.trim();
    assert.ok(isAbsolute(printed), `stdout must be an absolute path, got: ${printed}`);
    assert.ok(printed.endsWith("report.pdf"));
    assert.ok(existsSync(printed), "the downloaded file must exist");
    assert.equal(readFileSync(printed, "utf8"), "%PDF-1.4 converted");
    assert.deepEqual(
      gw.requests.map((q) => `${q.method} ${q.path}`),
      ["POST /v1/convert/doc-to-pdf", "GET /presigned/report.pdf"],
    );
  } finally {
    await gw.close();
  }
});

test("test_url_only_prints_presigned_url_and_downloads_nothing", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");
    routeEnvelope(gw, "/v1/convert/doc-to-pdf", "/presigned/report.pdf", "report.pdf");
    servePresigned(gw, "/presigned/report.pdf", "%PDF-1.4 converted");

    const r = await runCli(["convert", "report.docx", "--to", "pdf", "--url-only"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${gw.url}/presigned/report.pdf\n`);
    assert.equal(gw.requests.length, 1, "only the POST; --url-only must not download");
    assert.ok(!existsSync(join(home, "report.pdf")), "no output file must be written");
  } finally {
    await gw.close();
  }
});

test("test_output_dash_streams_exact_bytes_to_stdout", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");
    routeEnvelope(gw, "/v1/convert/doc-to-pdf", "/presigned/report.pdf", "report.pdf");
    const bytes = "%PDF-1.4 exact-byte-payload\nline2";
    servePresigned(gw, "/presigned/report.pdf", bytes);

    const r = await runCli(["convert", "report.docx", "--to", "pdf", "-o", "-"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, bytes, "-o - must emit the artifact bytes verbatim, nothing else");
    assert.ok(!existsSync(join(home, "report.pdf")), "no file output in -o - mode");
  } finally {
    await gw.close();
  }
});

test("test_skip_existing_skips_conversion_with_zero_uploads", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");
    writeFileSync(join(home, "report.pdf"), "already here");
    routeEnvelope(gw, "/v1/convert/doc-to-pdf", "/presigned/report.pdf", "report.pdf");

    const r = await runCli(["convert", "report.docx", "--to", "pdf", "--skip-existing"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests.length, 0, "--skip-existing must decide before uploading");
    assert.equal(r.stdout, "", "nothing was produced, nothing on stdout");
    assert.equal(readFileSync(join(home, "report.pdf"), "utf8"), "already here", "the existing file is untouched");
  } finally {
    await gw.close();
  }
});

test("test_json_prints_the_raw_envelope_verbatim", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");
    routeEnvelope(gw, "/v1/convert/doc-to-pdf", "/presigned/report.pdf", "report.pdf");

    const r = await runCli(["convert", "report.docx", "--to", "pdf", "--json"], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.requests.length, 1, "--json mode must not download the artifact");
    const jobId = field(multipartOf(gw), "job_id")?.value.toString("utf8") ?? "";
    assert.deepEqual(JSON.parse(r.stdout), {
      presigned_url: `${gw.url}/presigned/report.pdf`,
      object_key: "prod/files/proj_1/report.pdf",
      filename: "report.pdf",
      file_size: 11,
      conversion_time_seconds: 0.42,
      job_id: jobId,
    });
  } finally {
    await gw.close();
  }
});

test("test_500_on_post_recovers_by_polling_the_same_job_id", async () => {
  const gw = await startMockGateway();
  try {
    const home = scratchDir();
    writeFileSync(join(home, "report.docx"), "docx-content");
    const jobId = "recover42cafef00d";
    gw.json("POST /v1/convert/doc-to-pdf", 500, { detail: "worker crashed mid-flight" });
    gw.json(`GET /v1/convert/status/${jobId}`, 200, {
      status: "success",
      presigned_url: `${gw.url}/presigned/recovered.pdf`,
      object_key: "prod/files/proj_1/recovered.pdf",
    });
    servePresigned(gw, "/presigned/recovered.pdf", "%PDF-1.4 recovered");

    const r = await runCli(["convert", "report.docx", "--to", "pdf", "--job-id", jobId], {
      home,
      env: { ENCONVERT_API_URL: gw.url },
    });

    assert.equal(r.code, 0, `fallback should recover; stderr: ${r.stderr}`);
    // The POST carried the job_id...
    assert.equal(gw.requests[0]?.path, "/v1/convert/doc-to-pdf");
    assert.equal(field(multipartOf(gw, 0), "job_id")?.value.toString("utf8"), jobId);
    // ...and the recovery poll used the SAME id.
    const statusPolls = gw.requests.filter((q) => q.path.startsWith("/v1/convert/status/"));
    assert.ok(statusPolls.length >= 1, "a status poll must happen after the 500");
    for (const poll of statusPolls) {
      assert.equal(poll.method, "GET");
      assert.equal(poll.path, `/v1/convert/status/${jobId}`);
    }
    const printed = r.stdout.trim();
    assert.ok(printed.endsWith("report.pdf"));
    assert.equal(readFileSync(printed, "utf8"), "%PDF-1.4 recovered");
  } finally {
    await gw.close();
  }
});
