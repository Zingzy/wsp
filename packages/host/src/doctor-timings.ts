// SPDX-License-Identifier: AGPL-3.0-only

function fmtMs(ms: number): string {
  return ms < 10_000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export class Timings {
  rows: { step: string; ms: number; note: string }[] = [];
  async time<T>(step: string, fn: () => Promise<T>, note?: (v: T) => string): Promise<T> {
    const start = Date.now();
    const v = await fn();
    this.rows.push({ step, ms: Date.now() - start, note: note ? note(v) : "" });
    return v;
  }
  add(step: string, ms: number, note = ""): void {
    this.rows.push({ step, ms, note });
  }
  print(log: (line: string) => void): void {
    const w1 = Math.max(...this.rows.map(r => r.step.length), 4) + 2;
    log("");
    log("step".padEnd(w1) + "time".padEnd(10) + "note");
    log("-".repeat(w1 + 10 + 44));
    for (const r of this.rows) log(r.step.padEnd(w1) + fmtMs(r.ms).padEnd(10) + r.note);
    log("-".repeat(w1 + 10 + 44));
    log("TOTAL".padEnd(w1) + fmtMs(this.rows.reduce((a, r) => a + r.ms, 0)));
  }
}
