# Protocol

The typed contract every part of wsp speaks. Paths are under packages/protocol/ unless they start at the repo root.

## How it works

A computer's daemon can run a version behind the host and the app, and every frame it sends must still parse.
The daemon is Rust: it reads the fixtures under `daemon/fixtures/contract` and never this package's code.
`src/generated` is written from the Rust wsp-frames crate by `daemon/scripts/ts-types.sh`; never edit it by hand.
The daemon version is cut when a change lands, never on a branch. `src/format.ts` is the hub over `src/words/`, the words the app and the command line print.

## Invariants

1. A word or number changed in `src/daemon-contract.ts` moves the contract fixtures and so the daemon's sha, which
   cuts a daemon version (`packages/host/test/daemon-content.test.ts`).
2. No value import cycle between the package's modules: `src/format.ts` and `src/words/` import only types from `src/index.ts`
   (`test/import-cycles.test.ts`).
3. `src/index.ts` re-exports `src/format.ts` whole, so a local name in index.ts that matches a format export shadows
   it; and no file but `src/words/units.ts` spells out a byte formatter, the listed exceptions aside
   (`test/format.test.ts`).
4. A refusal has two halves, what happened and what to do (`test/refusal-shape.test.ts`); the exit class is read off
   the kind stamped on the error, never off its words (`test/exit.test.ts`).
5. The app says none of the retired words and names the computer by its own name (`test/person-words.test.ts`).
6. A test never writes a script and runs it; it uses `writeStub()` from `test/stub-script.ts`
   (`test/stub-script.test.ts`).
7. A test hands the environment it means into the code and reads no WSP_ variable off its own process but the
   `GATES` in `vitest.env.ts` (`test/test-env.test.ts`).
8. Nothing under src imports a node module: the web app and the desktop renderer bundle this package (no test yet).

## Traps

- A branch never bumps `DAEMON_VERSION`, `daemon/crates/wsp-frames/src/numbers.rs` or `daemon/fixtures/contract/numbers.json`: the landing's cut writes the number and the register sentence, so a daemon change writes its sentence in daemon/version-note.md (#1183).
- A frame that fails its schema is dropped whole, so a field made required that an older daemon does not send drops every such frame: `seq` on `ProcSnapshot` blanked the Processes pane. Keep it `.optional()` and read its absence (#1720).
- `ThreadView` is its own object, not an extension of `SessionView`: a field a thread shows goes on both and through `foldThreads()` (#1613).
- Read `SETUP_WORDS` and `placeWord()` before adding a state word: Behind already means a recipe change on its way or a daemon behind the host (#1482).
- `present` on a `PlaceProvisionRow` means the computer had it before wsp: a tool's on hook, a removal or a purge acts only on `installed` rows (#1481, #1482).
- A harness stores the prompt it was handed, not the person's words: `storedTitleSource()` matches the opening words plus `ATTACHED_FILES_HEAD`, the head `attachedFilesPrompt()` writes (#1689).

## One home for

| Rule | File | Function |
|---|---|---|
| a place's daemon behind this host | `src/index.ts` | `placeDaemonBehind()` |
| a computer's STATE word | `src/index.ts` | `placeStateOf()` |
| turns folded into one thread | `src/index.ts` | `foldThreads()` |
| an error's exit class | `src/exit.ts` | `exitClassOf()` |
| a refusal in two halves | `src/exit.ts` | `refusal()` |
| bytes as a person reads them | `src/words/units.ts` | `fmtBytes()` |
| hidden values blanked in a sentence | `src/words/thread.ts` | `redacted()` |
| the tools a harness reports | `src/words/tools.ts` | `TOOL_ROWS` |
| image caps and types | `src/attachments.ts` | `IMAGE_MAX_BYTES` |
| the cpu time ps prints | `src/ps-time.ts` | `psCpuSeconds()` |
| a value quoted for a shell | `src/shell-quote.ts` | `shellQuote()` |
