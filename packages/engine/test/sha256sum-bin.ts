// SPDX-License-Identifier: AGPL-3.0-only
// A sha256sum for the scripts these tests run through a real shell. The one
// reading of a file's bytes both platforms answer the same way: BSD carries no
// sha256sum on every release and GNU has no shasum everywhere, and node is
// what is running the test.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA256SUM = [
  "#!/bin/sh",
  `exec ${JSON.stringify(process.execPath)} -e 'const {createHash}=require("crypto");const fs=require("fs");const hash=b=>createHash("sha256").update(b).digest("hex");const files=process.argv.slice(1);if(files.length===0){process.stdout.write(hash(fs.readFileSync(0))+"  -\\n")}else{for(const f of files){process.stdout.write(hash(fs.readFileSync(f))+"  "+f+"\\n")}}' "$@"`,
  "",
].join("\n");

/** A fresh directory holding that one program, for a PATH a script under test is run with. The caller removes it. */
export function sha256sumBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "wsp-sha256sum-"));
  writeFileSync(join(bin, "sha256sum"), SHA256SUM);
  chmodSync(join(bin, "sha256sum"), 0o755);
  return bin;
}
