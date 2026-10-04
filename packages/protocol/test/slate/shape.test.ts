import { describe, expect, it } from "vitest";
import { parseSlate, sketchSlate, slateResultShape, slateStartValues, type SlateDoc, type SlateJson } from "../../src/slate/index.js";

const EMAILS = [
  { messageId: "m1", fromAddress: "billing@vercel.com", subject: "Your invoice", receivedTime: "2026-10-04 09:12", flags: { seen: true } },
  { messageId: "m2", fromAddress: "ops@spoo.me", subject: "Traffic report", receivedTime: "2026-10-04 08:40", flags: { seen: false } },
];

const doc = (): SlateDoc =>
  parseSlate(`<slate title="Mail">
  <run name="inbox" tool="zoho-mail.zoho_list_emails" args={{ params: { account: "admin", limit: 12 } }} every={60} />
  <run name="df" cmd="df -h /" />
  <column>
    <output run={$inbox} label="Inbox" />
    <output run={$df} />
  </column>
</slate>`).document!;

const sketch = (values: Record<string, SlateJson>) => {
  const d = doc();
  return sketchSlate(d, { ...slateStartValues(d), ...values }, { version: 2 }).split("\n").slice(1);
};

describe("a tool run's result by its shape", () => {
  it("is a table for a list of records, facts with named lists for a record, text for text", () => {
    expect(slateResultShape(EMAILS)).toMatchObject({ kind: "table", columns: [{ key: "messageId", title: "Message id" }, { key: "fromAddress" }, { key: "subject" }, { key: "receivedTime" }] });
    const record = slateResultShape({ account: "admin", total: 2, tags: ["a", "b"], emails: EMAILS, deep: { a: { b: 1 } } });
    expect(record).toMatchObject({ kind: "record", facts: [{ label: "Account", value: "admin" }, { label: "Total", value: "2" }, { label: "Tags", value: "a, b" }] });
    expect(record.kind === "record" && record.nested.map(n => [n.title, n.shape.kind])).toEqual([["Emails", "table"], ["Deep", "record"]]);
    expect(slateResultShape("No new mail.")).toEqual({ kind: "text", text: "No new mail." });
    expect(slateResultShape([])).toEqual({ kind: "none" });
  });

  it("is said by the sketch as the person sees it, and a command's output still as lines", () => {
    const lines = sketch({ inbox: { state: "done", out: JSON.stringify(EMAILS), json: EMAILS, runs: 1 }, df: { state: "done", out: "[1,2]", json: [1, 2], runs: 1 } });
    expect(lines[0]).toBe("output $inbox: done, table of 2 rows: Message id, From address, Subj…  [output-1 output label=Inbox]");
    expect(lines.slice(1, 3)).toEqual(["output $df: done, 1 line  [output-2 output]", "  [1,2]"]);
    const nested = sketch({ inbox: { state: "done", json: { account: "admin", total: 2, emails: EMAILS }, runs: 2 } });
    expect(nested.slice(0, 3)).toEqual([
      "output $inbox: done, Account admin, Total 2  [output-1 output label=Inbox]",
      "  Emails: table of 2 rows: Message id, From address, Subject, Received time",
      "output $df: not run yet  [output-2 output]",
    ]);
    expect(sketch({ inbox: { state: "failed", err: "account not found", why: "the tool said it failed", runs: 1 } })[0]).toBe("output $inbox: failed, 1 line (the tool said it failed)  [output-1 output label=Inbox]");
    expect([...lines, ...nested].every(l => l.length <= 100)).toBe(true);
  });
});
