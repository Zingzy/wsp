// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compileSlate, SLATE_ACTIONS, SLATE_FUNCTIONS, SLATE_PIECES, SLATE_SOURCES, slateCatalog, slateTokens, validateSlate } from "../../src/index.js";

describe("the kit's registries", () => {
  it.each(Object.values(SLATE_PIECES).map(p => [p.type, p] as const))("%s has a purpose, a fallback, a sketch and an example that validates", (_type, piece) => {
    expect(piece.purpose).not.toBe("");
    expect(piece.fallback).not.toBe("");
    expect(typeof piece.sketch).toBe("function");
    const r = compileSlate(piece.example);
    expect(r.errors).toEqual([]);
    expect(Object.values(r.document!.pieces).some(p => p.type === piece.type)).toBe(true);
  });

  it.each(Object.values(SLATE_ACTIONS).map(a => [a.kind, a] as const))("%s has a consent rule, a refusal and an example that validates", (_kind, action) => {
    expect(action.consent).not.toBe("");
    expect(action.refusal).not.toBe("");
    const r = compileSlate(`state.view = ""\nstate.showAll = false\nb: button label="Go"\n  ${action.example}`);
    expect(r.errors).toEqual([]);
  });

  it.each(Object.entries(SLATE_FUNCTIONS))("%s's example is a valid expression", (_name, fn) => {
    const r = validateSlate({ schema: 1, root: "t", state: { note: "", done: false }, pieces: { t: { type: "text", props: { value: { bind: fn.example } } } } });
    expect(r.errors.filter(e => e.code !== "X408")).toEqual([]);
  });

  it.each(Object.values(SLATE_SOURCES).map(s => [s.name, s] as const))("%s's example binds", (_name, source) => {
    const r = validateSlate({ schema: 1, root: "t", pieces: { t: { type: "text", props: { value: { bind: source.example } } } } });
    expect(r.errors).toEqual([]);
  });
});

describe("the catalog", () => {
  it("answers the index in under 1,200 tokens of text, with the example that validates", () => {
    const index = slateCatalog({});
    expect(slateTokens(index.text)).toBeLessThan(1_200);
    expect(slateTokens(JSON.stringify({ ...index, text: undefined }))).toBeLessThan(1_200);
    expect(Object.keys(index.pieces!)).toEqual(Object.keys(SLATE_PIECES));
    expect(index.rules).toHaveLength(6);
    expect(compileSlate(index.examples![0]!).errors).toEqual([]);
  });

  it.each(Object.keys(SLATE_PIECES))("piece %s in under 200 tokens", type => {
    const a = slateCatalog({ piece: type });
    expect(a.piece!.type).toBe(type);
    expect(slateTokens(a.text)).toBeLessThan(200);
  });

  it.each(Object.keys(SLATE_SOURCES))("source %s in under 300 tokens", name => {
    const a = slateCatalog({ source: name });
    expect(a.source!.name).toBe(name);
    expect(slateTokens(a.text)).toBeLessThan(300);
  });

  it.each(Object.keys(SLATE_ACTIONS))("action %s in under 150 tokens", kind => {
    expect(slateTokens(slateCatalog({ action: kind }).text)).toBeLessThan(150);
  });

  it("answers functions under 700 tokens, and every example in examples validates", () => {
    expect(slateTokens(slateCatalog({ functions: true }).text)).toBeLessThan(700);
    for (const lines of slateCatalog({ examples: true }).examples!) expect(compileSlate(lines).errors).toEqual([]);
  });

  it("names the nearest when the ask is wrong", () => {
    expect(slateCatalog({ piece: "gauge" }).error).toBe('"gauge" is not a piece. The pieces are column, row, section, text, markdown, number, meter, facts, table, button, input or empty.');
    expect(slateCatalog({ source: "usag" }).error).toContain("did you mean usage?");
  });

  it("gives the source's paths with their types", () => {
    expect(slateCatalog({ source: "pr" }).source!.paths["pr.checks"]).toBe("[{ name: string, workflow: string, state: pass|fail|pending|skipped|cancelled, link: string, description: string, startedAt: time, completedAt: time }]");
    expect(slateCatalog({ source: "usage" }).source!.paths["usage.{session, week}"]).toBe("{ percent: number, resetsAt: time }");
  });
});
