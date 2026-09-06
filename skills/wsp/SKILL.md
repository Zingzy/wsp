---
name: wsp
description: How to set a person up on wsp from nothing and how to run work on wsp workspaces from the command line or the MCP tools. The numbered walkthrough from a health check to the first thread, the scan that reads their computer, the recipe minted from what their agents actually used, the two questions to put to them about the heavy rows and the sign-ins, the init you run for them and the sign-in lines you hand over as they come, every verb and tool with its flags, its inputs and an example, the loop for building a ticket on a workspace, where the person has to step in, what a machine costs and where its limits are, and the rules learned the hard way. Read it before setting anyone up, opening a thread, sending into one, forking a workspace or bringing a project home.
---

# wsp

wsp runs cloud machines called workspaces, forked in seconds from a golden image the person sealed with wsp init, each with coding agents working inside it as threads. The host on the person's computer (wsp up, or the desktop app) owns the machines and the keys; the wsp command line and the wsp MCP server are thin clients of that same host, so whatever you do here shows in the person's sidebar and they can read and answer any thread. Start with `workspaces` (or `wsp threads` on the command line) to see what is running. Open a thread with `thread_new`, giving the workspace, the task and the agent to run; it returns the reply when the turn ends. Continue a thread with `send`; `stop` ends a thread's running turn; run a command on a machine with `exec`; `snapshot` a workspace with a project loaded as a project golden and `new` from it so the next machine starts with the project in place; `import` lands a folder from this computer on a workspace's machine, `export` brings a folder and its agent sessions home; `forget` drops a workspace whose machine the provider no longer has, and `delete` deletes a workspace's machine and drops it here. `pause` naps a machine and `wake` wakes it; `thread_new`, `send` and `exec` wake a paused workspace themselves before running, so a paused one needs no wake first. Setting someone up from nothing is its own sequence, and the next section is that sequence: a health check, then `recipe_scan`, which writes nothing and gives every row a recommended value with one line of why, so you apply those and put only the rows whose reason says worth a question, then `recipe` with their answers, then `wsp init --recipe <path> --non-interactive --json` from a shell, which builds the golden and prints one JSON line per sign-in for you to hand to the person, since the sign-ins finish in their browser, then `wsp up` when nothing serves, which you run yourself.
## Setting a person up from nothing

Asked to set a person up, read this section before running a single verb: a verb's refusal is a branch in this list, not an answer to hand back. The road is a health check, then `wsp recipe scan`, which prints every option and writes nothing, then two questions to them, the heavy rows with their sizes and the sign-ins with their default choice, then `wsp recipe --tick used` with their answers, which writes the recipe, then `wsp init --recipe ~/.wsp/recipe.json --non-interactive --json`, which you run detached from a shell: it builds the golden and prints one JSON line per sign-in, the page and the code the person finishes in their own browser, and waits for them, then `wsp up`, which you run yourself when nothing serves, then the first workspace and `wsp thread new --in <name>` for the first thread. Two things are theirs and never yours: the sign-ins, which no tool can finish for them, and the keys, which live in their `.env` and are never typed into your terminal or read back to them. Starting the host is not one of them; `wsp up` reads those keys off the file itself, so nothing about them passes through you. Every step below ends in an `Expect:` line; run the command, read that line, and stop at the first one that does not match rather than carrying on. Read where they already are before running anything, and skip the steps that state has passed.

1. The health check comes before any verb: `wsp --version`. With no wsp on the path and a shell of your own, `npm i -g @zingzy/wsp` puts the `wsp` command there; prefer that over `npx @zingzy/wsp`, whose cache write fails under a sandboxed agent and leaves every command after it running with the sandbox off. Then `wsp threads --json`, which says whether a host is already serving. (`wsp doctor` is not this check: it forks a live machine to prove the whole reach path, it bills while it runs, and it does not speak JSON.)

   Expect: `wsp <version>`, then one JSON line, `{"threads":[]}` when nothing is running yet, which means a host is serving that state file: go to step 8. `wsp threads: no wsp host is serving <path>; run wsp up first` on stderr means nothing serves it: go to step 2, and do not report that line back as the answer, it is this list's first branch. A `command not found` with no shell to install from is the one thing to say and stop on, because nothing below can be run for them.

2. Ask `wsp up` which state they are in. It serves until it is stopped, so start it detached and read its first lines: `nohup wsp up > /tmp/wsp-up.log 2>&1 &` (a Mac has no `setsid`). Writing to a file is also what makes the keyless case answer in one line: off a terminal wsp refuses instead of opening a prompt nobody is there to answer.

   Expect: one of five answers in that log, and every one of them is a branch here, not a failure to report. `app         http://127.0.0.1:4400` with `runtime ws  ws://127.0.0.1:4410` is a key and a golden both there and the host now serving: go to step 8. `no golden yet; run wsp init` is the key there and the golden not: go to step 4. `Solari API key: no terminal to ask on; set it in the environment, ./.env, or ~/.wsp/.env.` is no key at all: go to step 3. A bind error naming 4410 or 4400 (`EADDRINUSE`, node's own words, not wsp's) means the key and the golden are both there and something else holds a port: start it again on a free pair, `nohup wsp up --port 4401 --ws-port 4411 > /tmp/wsp-up.log 2>&1 &`, give them the URL it printed rather than the default one, and go to step 8. `another wsp host (pid <n>) is already serving <path> on port <port>` means one of theirs is up already: start nothing, use that port, and go to step 8.

3. The keys are the person's. Ask them to write `SOLARI_API_KEY=<their key from console.getsolari.com>` into `~/.wsp/.env`, one line, and `ANTHROPIC_API_KEY=<key>` beside it when they pay Anthropic by the token; on a Claude subscription they skip that one and sign in on the machine during init instead. Do not ask them to paste a key into this conversation, do not print that file, and do not commit it. Then run step 2 again.

   Expect: `wsp up` no longer names the Solari key, and answers with one of the other lines from step 2.

4. Read everything before writing anything: `wsp recipe scan` prints every option and writes no file. Five tables: the agents, with what each one's history on this computer says; the tools, each with why it is there (`used 412 times in 37 sessions`, `installed here, never used`, `catalog default`), its download size and, in the last column, what to do about it; what else a package manager on this computer has that the image could take, by manager, with the line that installs each and its size; the commands their agents ran that the catalog does not carry, with counts; and the sign-ins, each with the choice that would be taken by default. `--json` gives all of it as one object with a `recommended` value and reason on every row, which is the form to read when you are deciding rather than showing. `--project <folder>` weighs the histories by a folder, so a setup for one project counts that project's sessions first. Read the why and the size on every row instead of taking the defaults as given: they come from what their agents actually ran, not from what is installed, and an agent with no thread adapter stays off, which is right, since a golden carries the agents that can run threads unless the person asks for another.

   Expect: the five tables on stdout, the agents and tools tables each ending in an `On:` line with the count and the total size, then `Nothing was written.` as the last line; `wsp recipe scan --json` answers with one object holding the same rows.

5. Put the two decisions to the person, each as one message, then write the recipe with their answers. First the heavy rows, over 300 MB, as one multiple-choice question with the size beside each and what the answer does to the total. Then the sign-ins, naming the default choice on each row and what the choices mean: copy it from this computer, sign in on the machine after the build, hand it an API key, or skip it. Then write: `wsp recipe --tick used`, plus `--set <id>=on|off` for every row they flipped, `--add <id>="<install line>"` for anything from the scan's own-computer table they want on the image, `--signin <id>=copy|machine|key|skip` for every sign-in they chose, and `--project <folder>` when the setup is for one project, so that project's history weighs first. All of them repeat, all of them go in one call, and the file is never edited by hand.

   ```
   Three heavy ones are ticked because they are installed on your computer, and your agents never used them:
   Java 21 (620 MB), Gradle (410 MB), Android SDK (1.2 GB). Which do you want on the machines?
   (a) none of them, 3.4 GB down to 1.2 GB   (b) Java only   (c) all three, and the build takes longer
   ```

   Expect: the tables again with every flip in them and the total moved by their sizes, then `Recipe written to <path>.` opening the last line, `~/.wsp/recipe.json` when the state file is the default one and a path beside their state file when it is not. That path is the one step 6 runs with.

6. Build the golden. Run init yourself, detached, with the recipe step 5 wrote:

   ```
   nohup wsp init --recipe ~/.wsp/recipe.json --non-interactive --json > /tmp/wsp-init.jsonl 2> /tmp/wsp-init.log &
   ```

   It boots one builder machine, installs what is ticked, and at each sign-in the recipe answered `machine` it prints one JSON object on stdout and waits: `{"event":"sign-in","tool":"gh","label":"GitHub CLI login","browserUrl":"https://github.com/login/device","code":"8F4A-C21B","nextCommand":"open 'https://github.com/login/device'","waitSeconds":960}`. Hand that line to the person as it comes: the page to open on their computer, the code when there is one, and the command that opens the page. No thread and no tool can sign in for them; the run asks the tool's own status on the machine and moves on when it says signed in, or when `waitSeconds` pass. Read `/tmp/wsp-init.jsonl` as it grows rather than waiting on the process, which keeps serving the app after the seal. Say what it costs before starting it: about $0.11 an hour while the builder runs, and it holds one of the account's two machine slots. When the person would rather drive the wizard themselves, `wsp init --recipe ~/.wsp/recipe.json` in their own terminal draws six screens, Agents, Tools, Also on this Mac, Sign-ins, wsp for your agents on this Mac, and Build, of which the recipe has answered the first three, so their run opens on Sign-ins and ends on Build.

   Expect: one `{"event":"sign-in-result","tool":"gh","label":"GitHub CLI login","state":"signed-in"}` line per hand-off (`"state":"not-signed-in"` with a `note` saying why when the person did not finish in time; the run seals either way), then `Golden v<n> sealed.` in the log, which is the seal, `Workspace first (<id>) forked from golden v<n>.` on the first seal, and `Open http://127.0.0.1:4400/`. A JSON line from `wsp threads` is not that proof: init serves a host for the whole wizard, before the sign-ins and the seal, so step 8 is what tells a sealed golden from an init still running.

7. The host is yours to start, never something to ask them for. Init serves it for as long as that process runs; when nothing serves once init has ended, or once the person's own init has been closed, run step 2's detached `wsp up` again yourself, on the free pair when step 2's bind error says a port is taken. Never say the host is theirs because it holds their keys; it reads them from their `.env` and they do not pass through you.

   Expect: `app         http://127.0.0.1:<port>` in the log, and `wsp threads --json` answering with one JSON line.

8. First workspace. The first seal forks one, named `first`, so on a fresh golden `wsp wake first` answers with its state (over MCP, `workspaces` lists it) and it is the one to use; `wsp new dev` makes another.

   Expect: `created dev <id>`, printed when the machine is booted and reachable, or with `--json` the creating stages and then the workspace, one JSON line each. `wsp new: no golden yet; run wsp init` instead means the host is serving without a sealed golden, because an init is still running or ended without sealing: wait for it, or go back to step 6. A refusal that names the account's machine cap means two are already up; the builder stays up ten minutes after a seal and counts as one, so right after a seal that is `first` and the builder, and the person chooses which workspace to pause.

9. Import the project: `wsp import <folder> --to first` prints the plan (the repository, the files and their size, the caches left behind, each secret-shaped file with its default, cut unless a rewrite is offered, and the agents with sessions for the folder) and moves nothing; put the secret-shaped rows to the person, then run it again with `--yes` for the defaults or `--keep <path>` for a row they want on the machine. It lands at the same path on the machine. Take `wsp snapshot first` once it lands, so the next workspace starts from a project golden with the project in place and no second upload.

   Expect: `wsp exec first -- ls <folder>` lists the repo on the machine and exits 0, and `wsp snapshot first` prints a `project golden <id>` line naming the project.

10. First thread: `wsp thread new --in first --cwd <the project folder on the machine, absolute> --notify me "<the task>"`.

    Expect: `thread <id>` as the first line on stdout, the reply on stdout when the first turn ends, and the same thread in the person's sidebar for them to answer. `--notify me` puts each later turn's end in front of them, so nobody polls.

Last, say what to run next inside their own agent, which is where the work happens from here. `wsp mcp install --agent <id>` puts the tools and this skill into that agent (repeatable, and `--json` for a machine to read; the agents the catalog knows a config for are listed under the verbs below). The tools show up only after that agent restarts, and the `wsp` command line does the same job until then, so nothing waits on the restart. In Claude Code the skill is then `/wsp`; in any agent the line to paste is `Use the wsp skill and open a thread on first that <the first task>.`

Expect: that agent lists the wsp tools once it has restarted, `thread_new` answers with a thread id, and that thread shows in the person's sidebar.

## Verbs and tools

The command line and the MCP server call the same functions. Every verb takes `--json` (one JSON line per protocol value, nothing else printed) and `--state <path>` (the state file the host serves; default `~/.wsp/state.json`, or `./.wsp/state.json` in a checkout with a `.env`). A workspace is named by its name, or by its id when two share a name. A thread is named by its id or by a prefix that picks exactly one. Each tool's inputs are in the parentheses after its name; a flag on the command line is the input of the same name on the tool, `--add-check` being `add_check`, and a repeatable flag is an array.

| command line | MCP tool | what it does |
|---|---|---|
| `wsp threads [--in <workspace>]` | `workspaces`, `threads` (workspace) | the sidebar's rows: workspace, agent, state (running, completed, interrupted, failed), who opened it (person, cli, agent), the folder it works in, the title; `workspaces` is the workspace rows alone |
| `wsp new <name> [--from <project golden>]` | `new` (name, from) | a workspace forked from the golden's head, or from a project golden by project name or snapshot id; booted and reachable when it returns |
| `wsp fork <workspace> [--name <n>] [--send "<task>"] [--agent <id>] [--model <slug>] [--effort <word>] [--access <word>] [--cwd <path>] [--notify <thread\|me>]` | `fork` (workspace, name, task, agent, model, effort, access, cwd, notify) | a sibling from the source's golden version (a new machine, not a copy of its live disk); with a task, its first thread, and the flags after `--send` are thread new's |
| `wsp pause <workspace>` | `pause` (workspace) | naps the machine; it wakes on the next thread or command |
| `wsp wake <workspace>` | `wake` (workspace) | wakes the machine ahead of a thread or command and prints its state after; a running one comes back unchanged |
| `wsp forget <workspace> [--yes]` | `forget` (workspace) | drops a workspace whose machine is gone: its record and threads leave this computer; refused while the machine exists |
| `wsp delete <workspace> [--yes]` | `delete` (workspace, confirm) | deletes the machine at the provider, then drops the workspace's record and threads from this computer; nothing left on that disk survives, and the tool deletes only when called with confirm true |
| `wsp thread new --in <workspace> [--agent <id>] [--model <slug>] [--effort <word>] [--access <word>] [--cwd <path>] [--notify <thread\|me>] "<task>"` | `thread_new` (workspace, task, agent, model, effort, access, cwd, notify) | opens a thread and follows its first turn to the reply |
| `wsp send <thread> [--model <slug>] [--effort <word>] [--access <word>] "<message>"` | `send` (thread, message, model, effort, access) | a message into an existing thread; follows the turn to the reply |
| `wsp stop <thread>` | `stop` (thread) | ends the thread's running turn, as the app's stop button does; the machine stays up |
| `wsp exec <workspace> -- <command...>` | `exec` (workspace, argv) | runs the command on the machine, each word as given, waking it first when it is paused; output lines and the exit code |
| `wsp snapshot <workspace>` | `snapshot` (workspace) | a project golden: the golden plus the loaded project as it stands |
| `wsp export <workspace> <folder> [--from <path>] [--replace] [--agents <ids>]` | `export` (workspace, folder, from, replace, agents) | the folder and the agent sessions keyed to it come home to this computer |
| `wsp import <folder> --to <workspace> [--yes] [--keep <path>] [--cut <path>] [--agents <ids>] [--replace]` | `import` (workspace, folder, yes, keep, cut, agents, replace) | the folder lands on the machine at its path here, as the app's import does; without yes, keep or cut it answers with the plan and moves nothing (a person at a terminal is asked once instead) |
| `wsp recipe scan [--project <folder>] [--json]` | `recipe_scan` (project) | reads this computer and prints every option, writing nothing: the agents, the tools with why and size, what else a package manager here has that the image could take, the commands the agents ran, and the sign-ins, each with what to do about it and why |
| `wsp recipe [--tick used\|installed\|default] [--set <id>=on\|off] [--signin <id>=copy\|machine\|key\|skip] [--add <id>=<command>] [--add-check <id>=<command>] [--project <folder>] [--out <path>] [--json]` | `recipe` (tick, set, signin, add, add_check, why, project, out) | writes the recipe for a machine and prints it as a table: every catalog agent and tool with its tick, why, and its size, and the commands the agents ran that the catalog does not carry; `why` on the tool says what the added rows are for |

The command line alone has `wsp up`, `wsp init`, `wsp doctor` and `wsp mcp`, since each starts or installs something on the person's computer: `wsp up [--port <n>] [--ws-port <n>] [--state <path>]` serves the host; `wsp init [--recipe <path>] [--non-interactive] [--json] [--yes]` builds the golden, `--json` printing each sign-in and its outcome as one object on stdout with everything else on stderr, `--non-interactive` doing the same in prose, and `--yes` taking every default and skipping the sign-ins, which is why `--yes` is refused beside `--json`; `wsp doctor` forks a live machine to prove the reach path; `wsp mcp` serves the tools over stdio; `wsp mcp install --agent <id>` writes the server into that agent's own MCP config and this skill into its skills folder. `--agent` repeats to do several in one call, one failing id costing the others nothing, and `--json` answers with one line holding what each agent took and a `failures` array, exit 1 when that array is not empty. An entry under `installed` with no `path` took the skill and not the server, which is the by-hand line the prose prints. Only agents the catalog knows an MCP config for get the server: claude, codex, gemini, opencode. The rest get the skill and a by-hand line.

### thread new

```
wsp thread new --in dev --cwd /Users/zingzy/wsp --notify me "Read ticket 308 ... and build it."
wsp thread new --in dev --model claude-sonnet-5 --effort low --access plan "Review the branch ticket/308."
```

`--in` is required. `--agent` names the agent to run in the thread; the host's default is claude, and a thread runs only on an agent the host has an adapter for (today, claude). `--model`, `--effort` and `--access` pick the model, the reasoning effort and the access mode by the agent's own words (`claude-sonnet-5`; `low`, `medium`, `high`; `plan`, `acceptEdits`, `bypassPermissions`), the same three the app's composer offers; absent, the agent's catalog defaults run, and a value the catalog does not list is refused before anything starts, naming the list. A cheaper model for a review is the usual pick. `--cwd` is an absolute path on the machine; without it the thread starts in the workspace's imported project folder, else in the home folder. A thread's folder decides which project state (sessions, memory, CLAUDE.md) the agent loads, so put a thread where its project is. `--notify me` sends one line to the person when each turn ends; `--notify <thread>` sends that line into another thread as a message (steered into its running turn or queued). The line reads `thread 1a2b3c4d finished (completed, 12m 4s, $0.41): <last line of the reply>`.

The command line streams the reply to stderr as it arrives and prints the last message on stdout when the turn ends, exit 0; a failed turn prints its reason on stderr, exit 1. The first stdout line is `thread <id>`, the id `send` takes. The MCP tool returns the reply text with the thread id, workspace id, agent and outcome. When the thread's previous turn did not finish (a deadline, a host restart, a nap), the reply text from `send` and `thread_new` opens with the line `previous turn was cut; resuming` and the structured output carries `afterCut: true`, and the command line prints that line on stderr before the reply; the agent then resumes a transcript that may be missing its last steps, so restate what matters.

### send

```
wsp send 1a2b3c4d "Also cover the codex case in the test."
wsp send 1a2b3c4d --model claude-opus-5 --effort high "Now the hard part."
```

A message into a thread whose turn is not running starts a new turn (outcome `started`), on the model, effort and access named or the thread's own. Into a thread whose turn is running: when the agent can take input mid-turn (Claude Code does) the message joins the running turn (outcome `steered`) and the reply is that turn's, on that turn's picks; otherwise the message waits for the running turn to end and then runs (outcome `queued`). The command line says which on stderr. A person's message on the same thread lands in order with yours. Never start a second thread to hurry a running one.

### stop

```
wsp stop 1a2b3c4d
```

Ends the thread's running turn through the runtime, the way the app's stop button does; the turn ends with status interrupted and whoever followed it gets `turn interrupted`. The line says `thread <id> stopped`, or `thread <id> not running` when the turn had already ended; both exit 0, since neither is an error. The machine is not paused or killed and the thread takes the next `send`. Use it when a `send` started a turn you did not mean to, instead of pausing the workspace.

### exec

```
wsp exec dev -- sh -c 'cd /Users/zingzy/wsp && git status --short'
```

Each word after `--` reaches the machine as one argument; a shell line goes through `sh -c`. The command's exit code is the verb's. A non-zero exit is a result; the machine going away is an error. The machine runs as root with home /root and no login shell, so `bash -c`, never `bash -lc`.

### new, fork, snapshot

```
wsp snapshot dev                      # project golden of dev: its golden plus the imported project
wsp new dev-2 --from wsp              # a machine from that project golden, project in place, no upload
wsp fork dev --send "Run the gate."   # a sibling machine from dev's golden version, first thread opened
```

`fork` copies the golden version, not the live disk: work on the source's disk is not on the fork. Fork from a project golden when the fork needs the project. When a fork's first turn fails, the workspace still exists and the error names it; continue with `thread new` on it, do not fork again. `snapshot` takes only a running first-life machine with a project imported; a woken machine or one without a project is refused in one line and nothing is taken.

### import

```
wsp import /Users/zingzy/wsp --to dev            # the plan; a person is asked once, a pipe or an agent gets the plan and nothing moves
wsp import /Users/zingzy/wsp --to dev --yes      # the plan's defaults: secret-shaped files cut, rewrites taken, sessions of every listed agent
wsp import /Users/zingzy/wsp --to dev --keep .env --agents claude
```

The folder lands at the same path on the machine, which must not exist there unless `--replace`; caches (installs, build output) stay behind and are recreated on the machine. A secret-shaped file is cut unless `--keep` names it; a repository config with a token in a URL is offered rewritten and lands bare by default, `--cut` keeps it off. `--agents` narrows whose sessions travel, keyed to the path on the machine; each id must have sessions in the plan. The workspace must be running: a paused one is refused in one line, wake it first. `--json` prints the plan and then the result as one JSON line each.

### export

```
wsp export dev /Users/zingzy/wsp-from-dev --agents claude
```

The folder must not exist on this computer unless `--replace`. `--from` is the folder's path on the machine, the same path as the destination when absent. The sessions keyed to the folder land in each agent's home here, keyed to the new path.

## The loop for building with wsp

1. One workspace with the repo imported (`wsp import <folder> --to <workspace>` on a fresh workspace, the app's import dialog, or `new --from` a project golden taken after an import). `wsp threads --in <workspace>` shows what is on it.
2. One thread per ticket, each in its own worktree: the brief opens with `git worktree add -b ticket/<n>-<slug> <folder> origin/main`, and `--cwd` points at the repo. Two threads writing in one checkout collide.
3. The brief names the ticket, the files to read whole, the laws (the repo's review skill), the exact test commands and the proof required. A brief that says "fix the bug" comes back with a guess.
4. Start builder threads with `--notify me` when you are a person, or `--notify <your thread>` when you are an agent that wants to keep working; then do not poll `threads`, the line arrives. Both `wsp thread new` and the `thread_new` tool follow the first turn and return only when it ends, so over MCP a coordinator runs one builder at a time. On the command line a builder that should run beside you is started detached, `nohup wsp thread new ... > /tmp/<name>.log 2>&1 &` (a Mac has no `setsid`; a wsp machine does), and its id is the log's first `thread <id>` line.
5. A review is its own thread on the same workspace with the branch name and the review skill; the builder fixes in its thread through `send`. A review runs well on a cheaper model, `--model` on thread new.
6. Work leaves the machine by `git push` from the thread (only when the golden signed in to GitHub during wsp init) or by `export` to this computer.
7. Gates (full test runs, builds, packaging) run on the person's machine or one at a time on the workspace. A 2 vCPU, 4 GB machine runs one build or one agent at a time; two starve the daemon and the app reads the machine as not answering.

## Where the person steps in

- Sign-ins happen on the machine during wsp init, and each page is opened and finished on the person's computer: the run hands it over and waits. A thread cannot sign in for them; if `gh auth status` fails on the machine, say so and export instead of pushing.
- Keys (the Solari key, an Anthropic key) live in the person's `.env` and never reach a thread. A secret a thread needs is asked for through wsp, not typed into a terminal.
- The account holds two machines at once. A third `new` or `fork` is refused; the person decides which workspace to pause.
- A pause or a wake that does not return is stuck on the provider side; tell the person rather than retrying in a loop.
- Every workspace is the golden's size (2 vCPU, 4 GB); there is no size to choose at fork yet.
- An import cuts every secret-shaped file unless `--keep` names it; the plan's rows are the person's to answer before `--yes`.
- The heavy rows and the sign-in choices in the recipe are the person's answers, put to them before anything is built.

## Costs and limits

- A workspace costs about $0.11 an hour while awake (2 vCPU at $0.035 per vCPU-hour plus 4 GB at $0.01 per GB-hour). Snapshots are free up to 10 GB an organization, then $0.05 per GB-month from 2026-10-01.
- A workspace naps by itself after 20 minutes without a person, a thread or a command touching it; the next thread, send or exec wakes it, with `waking <name>` on stderr from the command line, and `wsp wake` wakes it ahead of them.
- A turn is cut after 10 minutes with no output from the agent, and at 6 hours in all. A long silent step (a full install, a build) needs output flowing or it ends the turn.
- The root disk is 20 GB; wsp keeps 2 GB free and skips tool installs that would go under it.
- One thread runs one agent process; a 4 GB machine runs one build or one agent at a time. Put a second builder on a second workspace, not a second thread on the same one.
- A turn runs on the model, effort and access mode named with `--model`, `--effort` and `--access` (the tool inputs of the same names), else the agent's catalog defaults. Choose the role by the brief and the picks, and keep review threads short and cheap.

## Tools the catalog does not carry

`wsp recipe` ticks catalog rows. A tool the person's projects use that the catalog has no row for goes on the image as its own row:

```
wsp recipe --add just="brew install just" --add-check just="just --version"
wsp recipe --add ruff="uv tool install ruff"
```

`--add <id>=<install command>` is repeatable and `--add-check <id>=<command>` says what proves the tool landed (without one, `command -v <id>`). The line runs on the machine as given, as root, after every catalog install, with Homebrew and apt already there. Rules for adding one:

- Add only what the person's own history or their repository files show in use: a formula in their Brewfile, a tool their agents ran, a runner their project's config names. Never add on a guess.
- Prefer a Homebrew, npm, uv or apt form (`brew install x`, `npm install -g x`, `uv tool install x`, `apt-get install -y x`) over a downloader. A line that pipes a download into a shell is refused in review.
- One tool per row, so a row that fails names the tool that failed. A failed row does not fail the build; it is listed as failed on the machine's lineage.
- There is no sign-in for these rows. A tool that needs a login needs a catalog row; say so instead of adding it.

`wsp init` also offers what this Mac's package managers already have, on the Also on this Mac screen, and a tick there writes the same kind of row with the size measured here.

## Rules learned the hard way

- A send into a running thread steers it or waits behind it, never a second concurrent turn (#274).
- A thread's end reaches its parent thread or the person only when its start said `--notify`; nothing polls (#286).
- A thread works in `--cwd` or the workspace's project folder; a relative `--cwd` is refused before anything starts (#280).
- A turn ends on 10 minutes of silence, not a 15 minute wall clock; long steps must print (#295).
- `thread new` and `send` return when the reply is complete, not when the process is reaped minutes later (#293).
- A turn's process group dies with the turn; a server that must outlive it starts with `setsid nohup ... &` (#275).
- Snapshot only a running first-life machine with a project loaded; a woken machine is refused (#223).
- Export refuses an existing folder; `--replace` overwrites it on purpose (#224).
- A resumed thread runs in the folder its session started in, whatever folder is followed in the app (#236).
- A send carries its own request id, so two clients sending the same text do not adopt each other's turn (#239).
- The MCP server and the command line refuse a host of another version in one line; restart it with wsp up (#290).
- Not here yet: picking a machine size (#301), a GitHub credential on the machine outside a sign-in during init (#279).
