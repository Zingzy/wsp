# Adding a tool to wsp-mcp

`computers` is the pattern. A tool here answers with the same bytes the TypeScript server in `packages/host` answers with, so every step below is held to that server by a test that goes red first.

## 1. Record its answers

The tool's entry (name, description, both schemas) is already in `record/tools/<name>.json`: the record test writes every tool the TypeScript server lists. What you add is what the host answers.

In `packages/host/test/mcp-record.test.ts`, add the tool to `ANSWERED`: one case per shape worth holding, each with the arguments and the frame the host answers every op the tool asks. Put the awkward bytes in the frames (a C1 control, a quote, text past ASCII, a fraction), and include one refusal. Run the test; it fails and prints a folder. Copy it over as it says. `tests/contract.rs` now fails on your tool with `Tool <name> not found`.

## 2. Write it

Add `src/tools/<name>.rs` (or one file per group) after `computers.rs`:

- `NAME`, and `TOOL` with the recorded entry through `include_str!` and a `call` that boxes your async fn.
- An `In` struct and an `Out` struct, both `Serialize` and `Deserialize`, with `#[cfg_attr(test, derive(schemars::JsonSchema))]`. Add the `its_structs_are_the_recorded_schemas` test; it holds the fields, the required set and every typed field's type to the recorded schemas.
- Read the arguments with `input(NAME, arguments)?`, get the socket with `host.client().await?`, ask with `client.request::<Reply>(op, params)`.
- Answer with `Answer::json(&out)` where the TypeScript tool uses `asJson`, and `Answer::text(text, &out)` where it uses `asText`.

Then add it to `TOOLS` in `src/tools/mod.rs`.

Things that break the byte compare:

- A view (anything the host sends that the tool does not reshape) is `Box<RawValue>`, never `Value`. `Value` sorts keys; the raw bytes keep the host's order, which is JavaScript's.
- A number from the host is never `f64`: serde prints `5.0` where JavaScript prints `5`. Pass it raw, or keep it as `serde_json::Number` read off the host's bytes.
- `Out`'s fields go in the order of the object literal the TypeScript tool builds, and an optional field is `Option<T>` with `#[serde(skip_serializing_if = "Option::is_none")]`, since JavaScript leaves `undefined` out.
- Arguments are refused before `call` runs, off the recorded input schema, in zod's words (`src/checked.rs`), so a wrongly typed field reads as the TypeScript server words it: `Expected string, received number at workspace`. Your `In` never sees bad input; `input()` failing means `In` disagrees with the schema, which `its_structs_are_the_recorded_schemas` catches first. A schema keyword the checker does not read fails `every_recorded_input_schema_uses_only_the_keywords_this_reads`. Teach it the keyword, and add a case to `REFUSED` in the record test so its words are held.
- A sentence the tool says is recorded, never written here: add it to `words()` in the record test and a field to `Words` in `src/record.rs`, with `{name}` wherever a value is filled.

## 3. Hold it to the command line

Add a row to `CALLED` in `packages/host/test/mcp-binary.test.ts`: the verb's words and the tool's arguments. The case calls the tool through the built binary against a host over the fake runtime and checks the answer equals the verb's `--json` object, its text byte for byte.

## Gates

```
cd daemon
cargo test -p wsp-mcp
cargo clippy --locked --all-targets --features wsp-daemon-bin/mcp -- -D warnings
cargo build -p wsp-daemon-bin --features mcp
cd ..
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 packages/host/test/mcp-record.test.ts
WSP_MCP_BIN=daemon/target/debug/wsp-daemon pnpm exec vitest run --minWorkers=1 --maxWorkers=2 packages/host/test/mcp-binary.test.ts
pnpm exec vitest run --minWorkers=1 --maxWorkers=2 packages/host/test/parity.test.ts packages/host/test/skill.test.ts packages/host/test/contract.test.ts
```

The budget (the greeting and the list with no host, under 50 ms and 10 MB) is the shipped profile's: `cargo test --release --features mcp -p wsp-daemon-bin --test bin the_tool_server`.

Nothing under this crate cuts a daemon version: the guest build leaves the feature off and `packages/host/test/daemon-content.test.ts` hashes around it. A change to `wsp-daemon-bin`, the workspace manifest or the lock still does.
