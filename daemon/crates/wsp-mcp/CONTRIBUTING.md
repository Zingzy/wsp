# Adding a tool to wsp-mcp

`computers` is the pattern. A tool here answers with the same bytes the TypeScript server in `packages/host` answers with, so every step below is held to that server by a test that goes red first.

## 1. Record its answers

The tool's entry (name, description, both schemas) is already in `record/tools/<name>.json`, once as the TypeScript server lists it with `WSP_CLOUD` off and once with it on, null in a state that lists no such tool. The record test writes every tool, and the server serves the state its own environment names. What you add is what the host answers.

In `packages/host/test/mcp-record.test.ts`, add the tool to `ANSWERED`: one case per shape worth holding, each with the arguments, the frame the host answers every op the tool asks, and `env` where the tool reads a variable. Put the awkward bytes in the frames (a C1 control, a quote, text past ASCII, a fraction), and include one refusal. The record keeps every op the call asked the host with its fields, and `tests/contract.rs` holds the Rust call to the same asks. Run the test; it fails and prints a folder. Copy it over as it says. `tests/contract.rs` now fails on your tool with `Tool <name> not found`.

A tool that follows events adds `pushed`, the frames the host pushes right behind each reply to an op, and `closes`, the op after whose reply the host lets the socket go as it stops (code 4001, which a follow dials through). A tool that reads this computer rather than a host runs the TypeScript wsp: its case carries `wsp`, the words it must run it with and what that printed, and `result`, the TypeScript tool's answer to the same call, as the recipe tools' cases in `packages/host/test/mcp-record-turns.ts` do; `platform` keeps a case whose text names this computer to the platform it names.

## 2. Write it

Add `src/tools/<name>.rs` (or one file per group) after `computers.rs`:

- `NAME`, and `TOOL` with the recorded entry through `include_str!` and a `call` that boxes your async fn.
- An `In` struct and an `Out` struct, both `Serialize` and `Deserialize`, with `#[cfg_attr(test, derive(schemars::JsonSchema))]`. Add the `its_structs_are_the_recorded_schemas` test; it holds the fields, the required set and every typed field's type to the recorded schemas.
- Read the arguments with `input(NAME, arguments)?`, get the socket with `host.client().await?`, ask with `client.request::<Reply>(op, params)`.
- Answer with `Answer::json(&out)` where the TypeScript tool uses `asJson`, and `Answer::text(text, &out)` where it uses `asText`.

Then add it to `TOOLS` in `src/tools/mod.rs`.

Things that break the byte compare:

- A view (anything the host sends that the tool does not reshape) is `Box<RawValue>`, never `Value`. `Value` sorts keys; the raw bytes keep the host's order, which is JavaScript's.
- A row the TypeScript tool parses with a zod schema (`SkillPreview.parse`, `z.array(SkillHit).parse`) is a struct in the schema's field order, not a view: zod drops a key the schema lacks and writes the schema's order, whatever the host sent.
- A number from the host is never `f64`: serde prints `5.0` where JavaScript prints `5`. Pass it raw, or keep it as `serde_json::Number` read off the host's bytes.
- `Out`'s fields go in the order of the object literal the TypeScript tool builds, and an optional field is `Option<T>` with `#[serde(skip_serializing_if = "Option::is_none")]`, since JavaScript leaves `undefined` out.
- Arguments are refused before `call` runs, off the recorded input schema, in zod's words (`src/checked.rs`), so a wrongly typed field reads as the TypeScript server words it: `Expected string, received number at workspace`. Your `In` never sees bad input; `input()` failing means `In` disagrees with the schema, which `its_structs_are_the_recorded_schemas` catches first. A schema keyword the checker does not read fails `every_recorded_input_schema_uses_only_the_keywords_this_reads`. Teach it the keyword, and add a case to `REFUSED` in the record test so its words are held.
- A sentence the tool says is recorded, never written here: add it to `words()` in the record test and a field to `Words` in `src/record.rs`, with `{name}` wherever a value is filled. The thread and turn tools keep theirs in `record/turns.json`, written by `turnWords()` in `mcp-record-turns.ts` and read by `src/tools/said.rs`. The one place the crate writes its own words is `src/tools/recipe.rs`, for what can go wrong between this server and the TypeScript wsp it runs: started with no wsp to run, a wsp that could not be started, printed nothing, exited without its failure object, or printed an object that does not read. The TypeScript tools run the collector in their own process, so none of these has a TypeScript twin to record.
- An optional input or output field is `Option<T>`; the schema test takes off the null schemars adds to one, since zod's optional takes no null.

## 3. Hold it to the command line

Add a row to `CALLED` in `packages/host/test/mcp-binary.test.ts`: the verb's words and the tool's arguments. The case calls the tool through the built binary against a host over the fake runtime and checks the answer equals the verb's `--json` object, its text byte for byte. `files` and `setup` put in place what the call acts on; `prose` holds the text to the line the verb prints without `--json`, for a tool that answers with `asText`; `twin` lets a tool that changes something act on a second thing beside the verb's, its answer the verb's with the one name for the other.

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
