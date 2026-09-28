# Adding a tool to wsp-mcp

`computers` is the pattern. A tool here answers with the same bytes the TypeScript server in `packages/host` answers with, so every step below is held to that server by a test that goes red first.

## 1. Record its answers

The tool's entry (name, description, both schemas) is already in `record/tools/<name>.json`, once as the TypeScript server lists it with `WSP_CLOUD` off and once with it on, null in a state that lists no such tool. The record test writes every tool, and the server serves the state its own environment names. What you add is what the host answers.

In `packages/host/test/mcp-record.test.ts`, add the tool to `ANSWERED`: one case per shape worth holding, each with the arguments, the frame the host answers every op the tool asks, and `env` where the tool reads a variable. Put the awkward bytes in the frames (a C1 control, a quote, text past ASCII, a fraction), and include one refusal. A group with many tools keeps its cases in a file of its own and spreads them into `ANSWERED`, as `mcp-record-turns.ts` and `mcp-record-workspaces.ts` do. Run the test; it fails and prints a folder. Copy it over as it says. `tests/contract.rs` now fails on your tool with `Tool <name> not found`.

Every case also records `asked`: each op the tool asked the host and the fields it asked it with. The replay compares them, so a field sent under the wrong name fails even where the answer's bytes match. A start's request id is noted as `<request id>` on both sides, since it is minted fresh on every call.

A tool that reads pushed frames (events, a turn, an export's stages) adds `pushed`: the frames the host pushes, by op, while that op is under way, before its reply. `closes` names the op after whose reply the host lets the socket go as it stops (code 4001, which a follow dials through). A tool that reads this computer rather than a host runs the TypeScript wsp: its case carries `wsp`, the words it must run it with and what that printed, and `result`, the TypeScript tool's answer to the same call, as the recipe tools' cases in `packages/host/test/mcp-record-turns.ts` do; `platform` keeps a case whose text names this computer to the platform it names.

A tool the TypeScript server serves with WSP_CLOUD on alone, and a case whose input only the cloud-on entry lists, adds `cloud: true`: it is recorded against that server loaded with the flag on, and replayed with it on.

## 2. Write it

Add `src/tools/<name>.rs` (or one file per group) after `computers.rs`:

- `NAME`, and `TOOL` with the recorded entry through `include_str!` and a `call` that boxes your async fn.
- An `In` struct and an `Out` struct, both `Serialize` and `Deserialize`, with `#[cfg_attr(test, derive(schemars::JsonSchema))]`. Add the `its_structs_are_the_recorded_schemas` test; it holds the fields, the required set and every typed field's type to the recorded schemas.
- Read the arguments with `input(NAME, arguments)?`, get the socket with `host.client().await?`, ask with `client.request::<Reply>(op, params)`.
- Answer with `Answer::json(&out)` where the TypeScript tool uses `asJson`, `Answer::text(text, &out)` where it uses `asText`, and `Answer::text_error(text, &out)` where it answers `{ ...asText(...), isError: true }`: a value carried by a call marked an error.
- A tool that reads pushed frames calls `client.frames()` before the request that pushes them and `client.events()` to subscribe once per socket; what the host pushed before a reply is there to take with `try_next` when the reply is read. A tool that starts a thread and follows its turn uses `src/tools/turn.rs` (`checked_start`, `notify_of`, `opening`, `follow`, `turn_refusal`, `turn_out`), which also dials again when the host stops under the turn.

Then add it to `TOOLS` in `src/tools/mod.rs`.

Things that break the byte compare:

- A view (anything the host sends that the tool does not reshape) is `Box<RawValue>`, never `Value`. `Value` sorts keys; the raw bytes keep the host's order, which is JavaScript's.
- A row the TypeScript tool parses with a zod schema (`SkillPreview.parse`, `z.array(SkillHit).parse`) is a struct in the schema's field order, not a view: zod drops a key the schema lacks and writes the schema's order, whatever the host sent.
- A number from the host is never `f64`: serde prints `5.0` where JavaScript prints `5`. Pass it raw, or keep it as `serde_json::Number` read off the host's bytes.
- `Out`'s fields go in the order of the object literal the TypeScript tool builds, and an optional field is `Option<T>` with `#[serde(skip_serializing_if = "Option::is_none")]`, since JavaScript leaves `undefined` out.
- Arguments are refused before `call` runs, off the recorded input schema, in zod's words (`src/checked.rs`), so a wrongly typed field reads as the TypeScript server words it: `Expected string, received number at workspace`. Your `In` never sees bad input; `input()` failing means `In` disagrees with the schema, which `its_structs_are_the_recorded_schemas` catches first. A schema keyword the checker does not read fails `every_recorded_input_schema_uses_only_the_keywords_this_reads`. Teach it the keyword, and add a case to `REFUSED` in the record test so its words are held. A key the entry does not list is taken out before `call`, as zod takes it out, so a field the cloud-off entry leaves out never reaches your tool; `In` holds every field some state lists, which is what `its_structs_are_the_recorded_schemas` checks.
- A sentence the tool says is recorded, never written here: add it to `words()` in the record test and a field to `Words` in `src/record.rs`, with `{name}` wherever a value is filled. A group with many sentences records them under one key of its own (`workspaces`) with a `Words` struct beside its tools; the thread and turn tools keep theirs in `record/turns.json`, written by `turnWords()` in `mcp-record-turns.ts` and read by `src/tools/said.rs`. Take a sentence off the function that says it with placeholders standing in for its values; where the sentence is inline in a tool, run the tool against the recording host with placeholder data and stand the known parts back in (`slot` in `mcp-record-workspaces.ts`). A count's two forms are two entries, the one form and the `{count}` form. The one place the crate writes its own words is `src/tools/recipe.rs`, for what can go wrong between this server and the TypeScript wsp it runs: started with no wsp to run, a wsp that could not be started, printed nothing, exited without its failure object, or printed an object that does not read. The TypeScript tools run the collector in their own process, so none of these has a TypeScript twin to record.
- An optional input or output field is `Option<T>`; the schema test takes off the null schemars adds to one, since zod's optional takes no null.

## 3. Hold it to the command line

Add a row to `CALLED` in `packages/host/test/mcp-binary.test.ts`: the verb's words and the tool's arguments. The case calls the tool through the built binary against a host over the fake runtime and checks the answer equals the verb's `--json` object, its text byte for byte. The row's optional fields: `files`, `setup` and `given` put in place what the call acts on (files under the home, command lines, or anything made through the runtime and the command line); `after` goes behind the verb line's own flags; `text: "prose"` holds the text to the line the verb prints without `--json`, for a tool that answers with `asText`; `heldHere` holds a tool that answers in a line of its own to this package's server's whole answer for the same call on the same host; `twin` lets a tool that changes something act on a second thing beside the verb's, its answer the verb's with the one name for the other; `first` runs a call that changes nothing (a delete not yet confirmed) before the verb, which does; `error` expects the answer marked an error while carrying the verb's value; `refused` expects the verb's failure object as the tool error, with nothing on the host to act on; `cloud` runs the verb, this package's server and the binary with WSP_CLOUD on. A tool whose second call answers differently from its first (a create, a snapshot) is held here by its refusals and in the record by its answers.

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
