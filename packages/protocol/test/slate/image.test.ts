import { describe, expect, it } from "vitest";
import { compileSlateText, parseSlate, sketchSlate, slateImageSource, slateImageTooBig, SLATE_CODES } from "../../src/slate/index.js";

const problems = (text: string) => { const r = parseSlate(text); return [...r.errors, ...r.warnings].map(p => `${p.code} ${p.message}`); };

describe("a slate image's src", () => {
  it("reads any path as a path on the thread's computer, whole or under its folder", () => {
    for (const path of ["/tmp/home.png", "shots/home.png", "../elsewhere/plot.png", "/etc/passwd", "C:\\shots\\a.png"]) expect(slateImageSource(path)).toEqual({ path });
  });

  it("reads an http or https address with its domain, lowercased", () => {
    expect(slateImageSource("https://GitHub.com/acme/lab/raw/main/a.png")).toEqual({ url: "https://github.com/acme/lab/raw/main/a.png", domain: "github.com" });
    expect(slateImageSource("http://img.acme.test:8080/a.png")).toEqual({ url: "http://img.acme.test:8080/a.png", domain: "img.acme.test" });
  });

  it.each([
    ["", "R900"],
    ["~/.ssh/id_ed25519.png", "R900"],
    ["file:///etc/hosts", "R917"],
    ["data:image/png;base64,AA", "R917"],
    ["javascript:alert(1)", "R917"],
    ["https://me:secret@acme.test/a.png", "R917"],
  ])("refuses %j with %s", (src, code) => {
    const read = slateImageSource(src);
    expect("problem" in read && read.problem.code).toBe(code);
    expect("problem" in read && read.problem.name).toBe(SLATE_CODES[code as keyof typeof SLATE_CODES]);
  });

  it("refuses an address it will not fetch at the write, and takes any path or https address", () => {
    expect(problems(`<slate><column><image src="file:///etc/hosts" /></column></slate>`)).toEqual([expect.stringMatching(/^R917 file:\/\/\/etc\/hosts is not an http or https address/)]);
    expect(problems(`<slate><column><image src="/tmp/home.png" caption="Home" /></column></slate>`)).toEqual([]);
    expect(problems(`<slate><column><image src="../../shots/home.png" /></column></slate>`)).toEqual([]);
    expect(problems(`<slate><column><image src="https://github.com/acme/lab/raw/main/a.png" /></column></slate>`)).toEqual([]);
  });

  it("holds a before and after to two images", () => {
    expect(problems(`<slate><column><images layout="compare" items={[{ p: "a.png" }]} src={item.p} /></column></slate>`)).toEqual(["T303 a compare shows exactly two images, before and after, and this list has 1"]);
    expect(problems(`<slate><column><images layout="compare" items={[{ p: "a.png" }, { p: "b.png" }]} src={item.p} /></column></slate>`)).toEqual([]);
  });

  it("refuses a list of more than 60 images, written out or bound, and takes 60", () => {
    const list = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ p: `/tmp/${i}.png` })));
    expect(problems(`<slate><column><images items={${list(61)}} src={item.p} /></column></slate>`)).toEqual(["R905 this list holds 61 images and a slate shows at most 60, so it shows none; show a page of them"]);
    expect(problems(`<slate><column><images items={${list(60)}} src={item.p} /></column></slate>`)).toEqual([]);
    const bound = compileSlateText(`<slate><value name="shots" start={[]} /><column><images id="g" items={$shots} src={item.p} /></column></slate>`).document!;
    const shots = Array.from({ length: 61 }, (_, i) => ({ p: `/tmp/${i}.png` }));
    expect(sketchSlate(bound, { shots })).toContain("this list holds 61 images and a slate shows at most 60, so it shows none; show a page of them, like items={$shots | take(60)}");
    expect(sketchSlate(bound, { shots: shots.slice(0, 60) })).not.toContain("at most 60");
  });

  it("says a size a byte over 10 MB as 10.1 MB, rounded up, never as the cap", () => {
    expect(slateImageTooBig("/tmp/a.png", 10 * 1024 * 1024 + 1).message).toBe("/tmp/a.png is 10.1 MB, over the 10 MB an image may weigh; save it smaller, or show a part of it");
    expect(slateImageTooBig("/tmp/a.png", 10.4 * 1024 * 1024).message).toMatch(/is 10\.4 MB, over/);
  });
});
