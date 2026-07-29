/**
 * U6 — pulling an endpoint whose `{param}` binds to nothing upstream.
 *
 * Xano treats an unbound `{param}` as inert route text, so a real workspace can
 * hold `GET /hey/{there}` with no inputs at all. SideStep refuses to AUTHOR that,
 * which means a faithful decode would emit a project that throws on import. The
 * decoder synthesizes the missing input instead and reports it every time —
 * re-deploying the generated tree binds a segment the source left inert, and
 * that is not something to discover from a diff.
 */
import { describe, it, expect } from "vitest";
import { decodeBundle } from "../../src/codegen/index.js";
import { severityOf } from "../../src/codegen/report.js";
import type { Bundle } from "../../src/workspace/export.js";
import { encodeQuery } from "../../src/kinds/query.js";
import { input } from "../../src/inputs/input.js";

/** A one-query bundle, built from the stored shape so it can be deliberately non-conforming. */
function bundleWith(query: Record<string, unknown>): Bundle {
  return {
    app: "xano",
    version: "1.0",
    type: "workspace",
    sig: "",
    payload: { query: [query] },
  } as unknown as Bundle;
}

/** The stored form of a query, with `input[]` overridable to an unbound state. */
function storedQuery(name: string, inputs: Record<string, ReturnType<typeof input.text>> = {}): Record<string, unknown> {
  // Encode a valid twin, then rewrite the name so the stored object can hold a
  // shape the authoring guard would reject.
  const encoded = encodeQuery({ name: "placeholder", verb: "GET", input: inputs }) as unknown as Record<
    string,
    unknown
  >;
  return { ...encoded, name, guid: "q".repeat(32) };
}

const sourceOf = (bundle: Bundle): string =>
  decodeBundle(bundle)
    .files.map((file) => file.contents)
    .join("\n");

describe("codegen — a {param} that binds to nothing upstream", () => {
  const unbound = bundleWith(storedQuery("hey/{there}"));

  it("declares the missing input so the generated tree builds", () => {
    expect(sourceOf(unbound)).toContain("there: input.text()");
  });

  it("reports it as a warning naming the segment and the consequence", () => {
    const entries = decodeBundle(unbound).report.entries.filter(
      (e) => e.category === "path-param-bound",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toMatch(/\{there\}/);
    expect(entries[0]!.detail).toMatch(/BINDS the segment/);
    expect(severityOf("path-param-bound")).toBe("warning");
  });

  it("keeps the endpoint name verbatim — only the input map is added to", () => {
    expect(sourceOf(unbound)).toContain('name: "hey/{there}"');
  });

  it("adds only the missing params, preserving the inputs that were there", () => {
    const partial = bundleWith(
      storedQuery("blog/{slug}/review/{review_id}", { slug: input.text() }),
    );
    const source = sourceOf(partial);
    expect(source).toContain("slug:");
    expect(source).toContain("review_id: input.text()");
    const entries = decodeBundle(partial).report.entries.filter(
      (e) => e.category === "path-param-bound",
    );
    // The reported list is what precedes ` in "<name>"` — the name itself still
    // mentions {slug}, which is correct.
    expect(entries[0]!.detail).toMatch(/^\{review_id\} in "/);
  });

  it("says nothing when every {param} is already bound", () => {
    const sound = bundleWith(storedQuery("blog/{slug}", { slug: input.text() }));
    expect(
      decodeBundle(sound).report.entries.filter((e) => e.category === "path-param-bound"),
    ).toEqual([]);
  });

  it("says nothing for a static endpoint name", () => {
    const plain = bundleWith(storedQuery("me", { email: input.text() }));
    expect(
      decodeBundle(plain).report.entries.filter((e) => e.category === "path-param-bound"),
    ).toEqual([]);
  });

  it("reports rather than crashes on a marker it cannot parse, emitting the name as-is", () => {
    const malformed = bundleWith(storedQuery("blog/post-{slug}"));
    const project = decodeBundle(malformed);
    const entries = project.report.entries.filter((e) => e.category === "path-param-bound");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toMatch(/will not import until the object is renamed/);
    expect(project.files.map((f) => f.contents).join("\n")).toContain('name: "blog/post-{slug}"');
  });
});
