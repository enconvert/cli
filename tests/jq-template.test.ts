// Unit tests for the bundled --jq subset (src/output/jq.ts) and the
// Go-template-flavoured --template renderer (src/output/template.ts),
// imported directly — no subprocess. Every construct documented in
// `enconvert help formatting` gets a test; error paths must throw a
// CliError with the usage exit code (2).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CliError, EXIT } from "../src/api/errors.js";
import { evaluateJq, formatJqResults } from "../src/output/jq.js";
import { renderTemplate } from "../src/output/template.js";

function assertUsageError(fn: () => unknown, messagePattern?: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof CliError, "must throw CliError");
    assert.equal(err.exitCode, EXIT.USAGE, "usage errors must carry exit code 2");
    if (messagePattern !== undefined) assert.match(err.message, messagePattern);
    return true;
  });
}

// ── jq: paths ────────────────────────────────────────────────────────────

test("jq_identity_returns_input", () => {
  assert.deepEqual(evaluateJq(".", { a: 1 }), [{ a: 1 }]);
});

test("jq_nested_field_access_a_b", () => {
  assert.deepEqual(evaluateJq(".a.b", { a: { b: "deep" } }), ["deep"]);
});

test("jq_missing_field_yields_null", () => {
  assert.deepEqual(evaluateJq(".nope", { a: 1 }), [null]);
});

test("jq_array_index_zero", () => {
  assert.deepEqual(evaluateJq(".[0]", ["first", "second"]), ["first"]);
});

test("jq_field_then_index", () => {
  assert.deepEqual(evaluateJq(".items[1]", { items: [10, 20, 30] }), [20]);
});

test("jq_negative_index_counts_from_the_end", () => {
  assert.deepEqual(evaluateJq(".[-1]", [1, 2, 3]), [3]);
  assert.deepEqual(evaluateJq(".items[-2]", { items: ["a", "b", "c"] }), ["b"]);
});

test("jq_bare_iterate_over_array", () => {
  assert.deepEqual(evaluateJq(".[]", [1, 2, 3]), [1, 2, 3]);
});

test("jq_iterate_over_object_values", () => {
  assert.deepEqual(evaluateJq(".[]", { x: 1, y: 2 }), [1, 2]);
});

test("jq_field_iterate_a_brackets", () => {
  assert.deepEqual(evaluateJq(".jobs[]", { jobs: [{ id: 1 }, { id: 2 }] }), [{ id: 1 }, { id: 2 }]);
});

test("jq_optional_field_on_scalar_yields_empty_stream", () => {
  assert.deepEqual(evaluateJq(".a?", 42), []);
});

test("jq_optional_field_on_object_still_accesses", () => {
  assert.deepEqual(evaluateJq(".a?", { a: 7 }), [7]);
});

// ── jq: pipes ────────────────────────────────────────────────────────────

test("jq_pipe_chains_stages", () => {
  assert.deepEqual(evaluateJq(".a | .b", { a: { b: 5 } }), [5]);
});

test("jq_iterate_then_pipe_field", () => {
  assert.deepEqual(
    evaluateJq(".jobs[] | .job_id", { jobs: [{ job_id: "j1" }, { job_id: "j2" }] }),
    ["j1", "j2"],
  );
});

// ── jq: builtins ─────────────────────────────────────────────────────────

test("jq_length_of_array_string_object_null", () => {
  assert.deepEqual(evaluateJq("length", [1, 2, 3]), [3]);
  assert.deepEqual(evaluateJq("length", "hello"), [5]);
  assert.deepEqual(evaluateJq("length", { a: 1, b: 2 }), [2]);
  assert.deepEqual(evaluateJq("length", null), [0]);
});

test("jq_keys_sorted_for_objects_indices_for_arrays", () => {
  assert.deepEqual(evaluateJq("keys", { b: 1, a: 2 }), [["a", "b"]]);
  assert.deepEqual(evaluateJq("keys", ["x", "y"]), [[0, 1]]);
});

test("jq_first_and_last", () => {
  assert.deepEqual(evaluateJq("first", [9, 8, 7]), [9]);
  assert.deepEqual(evaluateJq("last", [9, 8, 7]), [7]);
  assert.deepEqual(evaluateJq(".items | first", { items: ["a"] }), ["a"]);
});

test("jq_flatten_deep", () => {
  assert.deepEqual(evaluateJq("flatten", [[1, [2, [3]]], 4]), [[1, 2, 3, 4]]);
});

test("jq_type_names", () => {
  assert.deepEqual(evaluateJq("type", [1]), ["array"]);
  assert.deepEqual(evaluateJq("type", null), ["null"]);
  assert.deepEqual(evaluateJq("type", "s"), ["string"]);
  assert.deepEqual(evaluateJq("type", { a: 1 }), ["object"]);
});

// ── jq: select / join ────────────────────────────────────────────────────

test("jq_select_equality_filters_the_stream", () => {
  const data = { items: [{ status: "ok", n: 1 }, { status: "failed", n: 2 }, { status: "ok", n: 3 }] };
  assert.deepEqual(evaluateJq('.items[] | select(.status == "ok") | .n', data), [1, 3]);
});

test("jq_select_inequality", () => {
  const data = { items: [{ n: 1 }, { n: 2 }] };
  assert.deepEqual(evaluateJq(".items[] | select(.n != 1) | .n", data), [2]);
});

test("jq_select_with_non_string_literals", () => {
  const data = [{ ok: true }, { ok: false }];
  assert.deepEqual(evaluateJq(".[] | select(.ok == true)", data), [{ ok: true }]);
});

test("jq_join_with_separator", () => {
  assert.deepEqual(evaluateJq('join(",")', ["a", "b", "c"]), ["a,b,c"]);
  assert.deepEqual(evaluateJq('.urls | join(" ")', { urls: ["u1", "u2"] }), ["u1 u2"]);
});

test("jq_join_stringifies_non_string_items", () => {
  assert.deepEqual(evaluateJq('join("-")', [1, "a", true]), ["1-a-true"]);
});

// ── jq: error cases (all must be exit-2 CliErrors) ───────────────────────

test("jq_error_indexing_scalar_with_field", () => {
  assertUsageError(() => evaluateJq(".a", 5), /cannot index number/);
});

test("jq_error_indexing_object_with_number", () => {
  assertUsageError(() => evaluateJq(".[0]", { a: 1 }), /cannot index object/);
});

test("jq_error_iterating_a_scalar", () => {
  assertUsageError(() => evaluateJq(".[]", 3), /cannot iterate/);
});

test("jq_error_unterminated_bracket", () => {
  assertUsageError(() => evaluateJq(".[0", {}), /unterminated/);
});

test("jq_error_unsupported_expression", () => {
  assertUsageError(() => evaluateJq("to_entries", {}), /unsupported expression/);
});

test("jq_error_bad_select_literal", () => {
  assertUsageError(() => evaluateJq("select(.x == nope)", { x: 1 }), /cannot parse literal/);
});

test("jq_error_join_on_non_array", () => {
  assertUsageError(() => evaluateJq('join(",")', { a: 1 }), /join\(\) expects an array/);
});

test("jq_error_length_of_number", () => {
  assertUsageError(() => evaluateJq("length", 12), /has no length/);
});

// ── jq: result formatting (the gh --jq convention) ───────────────────────

test("jq_format_single_string_prints_raw", () => {
  assert.equal(formatJqResults(["pro"]), "pro");
});

test("jq_format_single_object_pretty_prints", () => {
  assert.equal(formatJqResults([{ a: 1 }]), JSON.stringify({ a: 1 }, null, 2));
});

test("jq_format_multiple_results_one_per_line_compact", () => {
  assert.equal(formatJqResults(["x", { a: 1 }, 3]), 'x\n{"a":1}\n3');
});

// ── template: placeholders ───────────────────────────────────────────────

test("template_simple_field_substitution", () => {
  assert.equal(renderTemplate("{{.name}}", { name: "report" }), "report");
});

test("template_nested_path", () => {
  assert.equal(renderTemplate("{{.a.b}}", { a: { b: "deep" } }), "deep");
});

test("template_dot_is_the_current_value", () => {
  assert.equal(renderTemplate("{{.}}", "raw"), "raw");
  assert.equal(renderTemplate("{{.}}", 7), "7");
});

test("template_missing_path_renders_empty", () => {
  assert.equal(renderTemplate("[{{.nope}}]", { a: 1 }), "[]");
});

test("template_object_value_renders_as_json", () => {
  assert.equal(renderTemplate("{{.o}}", { o: { k: 1 } }), '{"k":1}');
});

test("template_booleans_and_numbers_stringify", () => {
  assert.equal(renderTemplate("{{.ok}}/{{.n}}", { ok: true, n: 1.5 }), "true/1.5");
});

test("template_surrounding_literal_text_kept", () => {
  assert.equal(renderTemplate("status: {{.status}}!", { status: "done" }), "status: done!");
});

// ── template: escapes ────────────────────────────────────────────────────

test("template_backslash_n_and_t_escapes", () => {
  assert.equal(renderTemplate("{{.a}}\\n{{.b}}\\tend", { a: "1", b: "2" }), "1\n2\tend");
});

// ── template: range ──────────────────────────────────────────────────────

test("template_range_iterates_array_with_item_scope", () => {
  const data = { items: [{ id: "a" }, { id: "b" }] };
  assert.equal(renderTemplate("{{range .items}}{{.id}};{{end}}", data), "a;b;");
});

test("template_range_with_newline_escape_per_row", () => {
  const data = { jobs: [{ id: 1 }, { id: 2 }] };
  assert.equal(renderTemplate("{{range .jobs}}{{.id}}\\n{{end}}", data), "1\n2\n");
});

test("template_range_over_missing_path_renders_nothing", () => {
  assert.equal(renderTemplate("x{{range .nope}}{{.}}{{end}}y", { a: 1 }), "xy");
});

test("template_text_before_and_after_range_preserved", () => {
  const data = { items: ["p", "q"] };
  assert.equal(renderTemplate("<{{range .items}}{{.}}{{end}}>", data), "<pq>");
});

test("template_error_range_over_non_array_is_usage_error", () => {
  assertUsageError(
    () => renderTemplate("{{range .n}}{{.}}{{end}}", { n: 42 }),
    /range over non-array/,
  );
});
