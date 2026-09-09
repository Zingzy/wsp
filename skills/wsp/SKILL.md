---
name: wsp
description: How to set a person up on wsp from nothing and how to run work on wsp workspaces from the command line or the MCP tools. The numbered walkthrough from a health check to the first thread, the scan that reads their computer, the recipe minted from what their agents actually used, the two questions to put to them about the heavy rows and the sign-ins, the init you run for them and the sign-in lines you hand over as they come, every verb and tool with its flags, its inputs and an example, the loop for building a ticket on a workspace, where the person has to step in, what a machine costs and where its limits are, and the rules learned the hard way. Read it before setting anyone up, opening a thread, sending into one, forking a workspace or bringing a project home.
---

# wsp

wsp runs cloud machines called workspaces, forked in seconds from a golden image the person sealed with wsp init, each with coding agents working inside it as threads. This computer is a workspace too, the one `wsp new --local` makes: it forks nothing, costs nothing and runs threads on the agents already on its PATH, which is where a quick subtask or a second harness goes when nothing needs a machine. The host on the person's computer (wsp up, or the desktop app) owns the machines and the keys; the wsp command line and the wsp MCP server are thin clients of that same host, so whatever you do here shows in the person's sidebar and they can read and answer any thread. Start with `wsp workspaces` to see every workspace and `wsp threads` to see the threads inside them. Open a thread with `thread_new`, giving the workspace, the task and the agent to run; it returns the reply as soon as the agent gives it, and the thread reads running until the agent process exits. Continue a thread with `send`, which is also how one thread talks to another, by that thread's id off `threads`: a send is never refused for meeting a turn, it joins a running turn where the agent takes a message mid-turn and otherwise runs as that thread's next turn, and the answer comes back as its own message when the other thread's start named you. Both take `detach`, which answers with the thread id the moment the turn is started and leaves the reply to the thread's finished line. Which road you take for that line is decided by whether you are a wsp thread yourself, which the launch environment says: a thread starts every child with `--notify me` and ends its turn, and the child's finished line, carrying its whole report, wakes it as a message; a caller that is not a thread takes the reply of one turn as `thread_new` or `send` returns it, and for more than one turn at a time starts one coordinator thread on the local workspace with the whole job and hands off, telling the person where to read it. `stop` ends a thread's running turn; run a command on a machine with `exec`; `snapshot` a workspace with a project loaded as a project golden and `new` from it so the next machine starts with the project in place; `import` lands a folder from this computer on a workspace's machine, `export` brings a folder and its agent sessions home; `forget` drops a workspace whose machine the provider no longer has, and `delete` deletes a workspace's machine and drops it here. `pause` naps a machine and `wake` wakes it; `thread_new`, `send` and `exec` wake a paused workspace themselves before running, so a paused one needs no wake first. Setting someone up from nothing is its own sequence, and the next section is that sequence: a health check, then `recipe_scan`, which writes nothing and gives every row a recommended value with one line of why, so you apply those and put only the rows whose reason says worth a question, then `recipe` with their answers, then `wsp init --recipe <path> --non-interactive --json` from a shell, which builds the golden and prints one JSON line per sign-in for you to hand to the person, since the sign-ins finish in their browser, then `wsp up` when nothing serves, which you run yourself.
## Setting a person up from nothing

Asked to set a person up, read this section before running a single verb: a verb's refusal is a branch in this list, not an answer to hand back. The road is a health check, then `wsp recipe scan`, which prints every option and writes nothing, then two questions to them, the heavy rows with their sizes and the sign-ins with their default choice, then `wsp recipe --tick used` with their answers, which writes the recipe, then `wsp init --recipe ~/.wsp/recipe.json --non-interactive --json`, which you run detached from a shell: it builds the golden and prints one JSON line per sign-in, the page and the code the person finishes in their own browser, and waits for them, then `wsp up`, which you run yourself when nothing serves, then the first workspace and `wsp thread new --in <name>` for the first thread. Two things are theirs and never yours: the sign-ins, which no tool can finish for them, and the keys, which live in their `.env` and are never typed into your terminal or read back to them. Starting the host is not one of them; `wsp up` reads those keys off the file itself, so nothing about them passes through you. Every step below ends in an `Expect:` line; run the command, read that line, and stop at the first one that does not match rather than carrying on. Read where they already are before running anything, and skip the steps that state has passed.

1. The health check comes before any verb: `wsp --version`. With no wsp on the path and a shell of your own, `npm i -g @zingzy/wsp` puts the `wsp` command there; prefer that over `npx @zingzy/wsp`, whose cache write fails under a sandboxed agent and leaves every command after it running with the sandbox off. Then `wsp threads --json`, which says whether a host is already serving. (`wsp doctor` is not this check: it forks a live machine to prove the whole reach path, it bills while it runs, and it does not speak JSON.)

   Expect: `wsp <version>`, then one JSON line, `{"threads":[]}` when nothing is running yet, which means a host is serving that state file: go to step 8. `wsp threads: no wsp host is serving <path>; run wsp up first` on stderr means nothing serves it: go to step 2, and do not report that line back as the answer, it is this list's first branch. A `command not found` with no shell to install from is the one thing to say and stop on, because nothing below can be run for them.

2. Ask `wsp up` which state they are in. It serves until it is stopped, so start it detached and read its first lines: `nohup wsp up > /tmp/wsp-up.log 2>&1 &` (a Mac has no `setsid`). Writing to a file is also what makes the keyless case answer in one line: off a terminal wsp refuses instead of opening a prompt nobody is there to answer.

   Expect: one of five answers in that log, and every one of them is a branch here, not a failure to report. `app         http://127.0.0.1:4400` with `runtime ws  ws://127.0.0.1:4410` is a key and a golden both there and the host now serving: go to step 8. `nothing to serve yet; wsp new --local makes this computer a workspace, or wsp init seals a golden` is the key there and neither a golden nor a workspace: go to step 4, or `wsp new --local` first when this computer is enough to start on. `Solari API key: no terminal to ask on; set it in the environment, ./.env, or ~/.wsp/.env.` is no key at all: go to step 3. A bind error naming 4410 or 4400 (`EADDRINUSE`, node's own words, not wsp's) means the key and the golden are both there and something else holds a port: start it again on a free pair, `nohup wsp up --port 4401 > /tmp/wsp-up.log 2>&1 &` (the websocket port follows ten above the app port, so one flag moves both), give them the URL it printed rather than the default one, and go to step 8. `another wsp host (pid <n>) is already serving <path> on port <port>` means one of theirs is up already: start nothing, use that port, and go to step 8.

3. The keys are the person's. Ask them to write `SOLARI_API_KEY=<their key from console.getsolari.com>` into `~/.wsp/.env`, one line, and `ANTHROPIC_API_KEY=<key>` beside it when they pay Anthropic by the token; on a Claude subscription they skip that one and sign in on the machine during init instead. Do not ask them to paste a key into this conversation, do not print that file, and do not commit it. Then run step 2 again.

   Expect: `wsp up` no longer names the Solari key, and answers with one of the other lines from step 2.

4. Read everything before writing anything: `wsp recipe scan` prints every option and writes no file. Five tables: the agents, with what each one's history on this computer says; the tools, each with why it is there (`used 412 times in 37 sessions`, `installed here, never used`, `catalog default`), its download size and, in the last column, what to do about it; what else a package manager on this computer has that the image could take, by manager, with the line that installs each and its size; the commands their agents ran that the catalog does not carry, with counts; and the sign-ins, each with the choice that would be taken by default. `--json` gives all of it as one object with a `recommended` value and reason on every row, which is the form to read when you are deciding rather than showing. `--project <folder>` weighs the histories by a folder, so a setup for one project counts that project's sessions first. Read the why and the size on every row instead of taking the defaults as given: they come from what their agents actually ran, not from what is installed, and an agent with no thread adapter stays off, which is right, since a golden carries the agents that can run threads unless the person asks for another.

   Expect: the five tables on stdout, the agents and tools tables each ending in an `On:` line with the count and the total size, then `Nothing was written.` as the last line; `wsp recipe scan --json` answers with one object holding the same rows.

5. Put the two decisions to the person, each as one message, then write the recipe with their answers. First the heavy rows, over 300 MB, as one multiple-choice question with the size beside each and what the answer does to the total. Then the sign-ins, naming the default choice on each row and what the choices mean: copy it from this computer, sign in on the machine after the build, hand it an API key, or skip it. Then write: `wsp recipe --tick used`, plus `--set <id>=on|off` for every row they flipped and for anything from the scan's own-computer table they want on the image, `--add <id>="<install line>"` only for a tool neither the catalog nor this computer has, `--signin <id>=copy|machine|key|skip` for every sign-in they chose, and `--project <folder>` when the setup is for one project, so that project's history weighs first. All of them repeat, all of them go in one call, and the file is never edited by hand.

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

   Expect: `wsp exec first -- ls <folder>` lists the repo on the machine with the command's own exit code, 0, and `wsp snapshot first` prints a `project golden <id>` line naming the project.

10. First thread: `wsp thread new --in first --cwd <the project folder on the machine, absolute> --notify me "<the task>"`.

    Expect: `thread <id>` as the first line on stdout, the reply on stdout when it is complete, and the same thread in the person's sidebar for them to answer. `--notify me` puts each later turn's reply in front of them, so nobody polls.

Last, say what to run next inside their own agent, which is where the work happens from here. `wsp mcp install --agent <id>` puts the tools and this skill into that agent (repeatable, and `--json` for a machine to read; the agents the catalog knows a config for are listed under the verbs below). The tools show up only after that agent restarts, and the `wsp` command line does the same job until then, so nothing waits on the restart. In Claude Code the skill is then `/wsp`; in any agent the line to paste is `Use the wsp skill and open a thread on first that <the first task>.`

Expect: that agent lists the wsp tools once it has restarted, `thread_new` answers with a thread id, and that thread shows in the person's sidebar.

## Verbs and tools

The command line and the MCP server call the same functions. Every verb takes `--json` (one JSON object per line, frames first, the last line the result; see the contract below) and `--state <path>` (the state file the host serves; default `~/.wsp/state.json`, or `./.wsp/state.json` in a checkout with a `.env`). A workspace is named by its name, or by its id when two share a name. A thread is named by its id or by a prefix that picks exactly one. Each tool's inputs are in the parentheses after its name; a flag on the command line is the input of the same name on the tool, `--add-check` being `add_check`, and a repeatable flag is an array.

| command line | MCP tool | what it does |
|---|---|---|
| `wsp workspaces` | `workspaces` | every workspace this host runs, one row each: its name, its id, what its machine is (the provider's machine, or `this computer` for the local workspace), its state as the sidebar shows it (running, paused, waking or unreachable, off the phase with the provider's word for the machine and the daemon reach beside it) where the kind has one, and how many projects it holds. The name is what `--in` and every other verb take |
| `wsp projects <workspace>` | `projects` (workspace) | the projects on the workspace, oldest import first: name, the folder it landed at on the machine, size and when it landed. The name is what `--project` takes; a thread opened with neither `--project` nor `--cwd` starts in the project the last thread there used, else the workspace's only project, else the workspace's own folder |
| `wsp threads [--in <workspace>]` | `threads` (workspace) | the sidebar's rows: workspace, agent, state (running, completed, interrupted, failed), who opened it (person, cli, agent), the folder it works in, the title |
| `wsp new <name> [--from <project golden>] [--size <cpu>x<memGb>]`, or `wsp new --local [name]` for this computer, or `wsp new --ssh <user@host> [name] [--ssh-port <port>] [--ssh-key <path>]` for a machine of their own | `new` (name, from, size, local, ssh, ssh_port, ssh_key) | a workspace forked from the golden's head, or from a project golden by project name or snapshot id; booted and reachable when it returns. `--size` picks a machine size the provider offers, `2x4` for 2 vCPU and 4 GB; absent, the golden's size. `--local` makes the one local workspace, this computer, which forks nothing: one per host, its name this computer's own when none is given. `--ssh` records a machine they already have, reached with their own key and forking nothing: the name defaults to what the address calls the machine, `--ssh-port` and `--ssh-key` are for a port and a key ssh would not find itself, and the line prints the host key the machine answered with for them to compare |
| `wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>] [--send "<task>"] [--agent <id>] [--model <slug>] [--effort <word>] [--access <word>] [--cwd <path>] [--notify <thread\|me>]` | `fork` (workspace, name, size, task, agent, model, effort, access, cwd, notify) | a sibling from the source's golden version (a new machine, not a copy of its live disk); with a task, its first thread, and the flags after `--send` are thread new's |
| `wsp pause <workspace>` | `pause` (workspace) | naps the machine; it wakes on the next thread or command |
| `wsp wake <workspace>` | `wake` (workspace) | wakes the machine ahead of a thread or command and prints its state after; a running one comes back unchanged |
| `wsp rename <workspace> "<name>"` | `rename` (workspace, name) | names the workspace on this computer, the name every listing shows and the one `--in` takes; a name another workspace holds and a blank one are refused and nothing is renamed. Threads on the machine run on through it |
| `wsp rebuild <workspace>` | `rebuild` (workspace) | the road out of gone: a fresh machine from the workspace's image, with the vault its last nap left imported, under the same workspace, name and threads; prints the new machine's id and state, and is refused on a machine that still answers. Work written since that nap is not on it |
| `wsp image move <workspace>` | `image_move` (workspace) | moves the workspace onto the newest version of its image: a fresh machine of that image replaces the old one and the home folder comes across, less the files the image itself wrote and nobody changed here, whose newer copies come with the image. `kept` names the files of the image's own this workspace had changed and which travelled instead. Anything installed outside the home folder comes from the new image, and everything running on the old machine stops with it |
| `wsp forget <workspace> [--yes]` | `forget` (workspace) | drops a workspace whose machine is gone: its record and threads leave this computer; refused while the machine exists |
| `wsp delete <workspace> [--yes]` | `delete` (workspace, confirm) | deletes the machine at the provider, then drops the workspace's record and threads from this computer; nothing left on that disk survives, and the tool deletes only when called with confirm true |
| `wsp thread new [--in <workspace>] [--agent <id>] [--model <slug>] [--effort <word>] [--access <word>] [--project <name>] [--cwd <path>] [--notify <thread\|me>] [--title <name>] [--image <path>] [--detach] "<task>"` | `thread_new` (workspace, task, agent, model, effort, access, project, cwd, notify, title, images, detach) | opens a thread in the project named, else where the last thread on that workspace ran, and follows its first turn to the reply; without `--in`, run from inside a registered repo, it goes to the workspace that project last ran on and the first line says so; with `--detach`, prints the thread id the moment the turn is started and returns |
| `wsp thread rename <thread> "<title>"` | `thread_rename` (thread, title) | names the thread in the agent's own store on the machine, the field the agent writes when a person renames the session inside it, so wsp and the agent read the same name; `unsupported` where the agent keeps no name of a person's |
| `wsp send <thread> [--model <slug>] [--effort <word>] [--access <word>] [--image <path>] [--detach] "<message>"` | `send` (thread, message, model, effort, access, images, detach) | a message into an existing thread; follows the turn to the reply, or with `--detach` returns the moment the turn is started |
| `wsp stop <thread>` | `stop` (thread) | ends the thread's running turn, as the app's stop button does; the machine stays up |
| `wsp exec <workspace> [--cwd <dir>] -- <command...>` | `exec` (workspace, argv, cwd) | runs the command on the machine, each word as given, in the folder named or the one a thread would start in, waking it first when it is paused; output lines, the exit code and the folder it ran in |
| `wsp snapshot <workspace>` | `snapshot` (workspace) | a project golden: the golden plus the loaded project as it stands |
| `wsp folders [<folder>] [--hidden]` | `folders` (folder, hidden) | the folders directly inside one folder on this computer, each with whether git tracks it, for naming one to import; the roots are the home folder and every imported project, and a path outside them is refused |
| `wsp terminal config [--scheme light\|dark]` | `terminal_config` (scheme) | the Ghostty config on this computer as the app's terminal pane applies it, its includes followed and its theme resolved: the font and its fallbacks, the size, the colors, the cursor, the padding, the background opacity, and the blur, which is read but not applied; `files` empty means no config, and an absent key means the pane keeps its default |
| `wsp export <workspace> <folder> [--from <path>] [--replace] [--agents <ids>]` | `export` (workspace, folder, from, replace, agents) | the folder and the agent sessions keyed to it come home to this computer |
| `wsp import <folder> [--to <workspace>] [--yes] [--keep <path>] [--cut <path>] [--agents <ids>] [--replace]` | `import` (workspace, folder, yes, keep, cut, agents, replace) | the folder lands on the machine at its path here, as the app's import does; without yes, keep or cut it answers with the plan and moves nothing (a person at a terminal is asked once instead). On this computer's own workspace it registers the path, copies nothing and asks nothing. Without `--to` it goes to the workspace the last thread started on and says so |
| `wsp recipe scan [--project <folder>] [--json]` | `recipe_scan` (project) | reads this computer and prints every option, writing nothing: the agents, the tools with why and size, what else a package manager here has that the image could take, the commands the agents ran, and the sign-ins, each with what to do about it and why |
| `wsp recipe [--tick used\|installed\|default] [--set <id>=on\|off] [--signin <id>=copy\|machine\|key\|skip] [--add <id>=<command>] [--add-check <id>=<command>] [--project <folder>] [--out <path>] [--json]` | `recipe` (tick, set, signin, add, add_check, why, project, out) | writes the recipe for a machine and prints it as a table: every catalog agent and tool with its tick, why, and its size, and the commands the agents ran that the catalog does not carry; `--set` takes a catalog id or the id the scan gives a package this computer already has; `why` on the tool says what the added rows are for |

The command line alone has `wsp up`, `wsp down`, `wsp status`, `wsp init`, `wsp doctor` and `wsp mcp`, since each starts, stops or installs something on the person's computer: `wsp up [--port <n>] [--ws-port <n>] [--state <path>]` serves the host until it is stopped, so the terminal it runs in has to stay open; `wsp up --service` hands that same line to the computer's own service manager instead, a launchd agent on a Mac and a systemd user unit on Linux, which serves now and again at every login, and `wsp down` stops it and takes it away. A service starts without the shell that installed it, so the Solari key has to be in `~/.wsp/.env` and not exported in that shell, and `wsp up --service` refuses with that line when it is only in the shell. `wsp status` prints whether a host is serving this state file, its ports, its token file and what keeps it there, with a non-zero exit code when none does; `wsp init [--recipe <path>] [--non-interactive] [--json] [--yes]` builds the golden, `--json` printing each sign-in and its outcome as one object on stdout with everything else on stderr, `--non-interactive` doing the same in prose, and `--yes` taking every default and skipping the sign-ins, which is why `--yes` is refused beside `--json`; `wsp doctor` forks a live machine to prove the reach path; `wsp mcp` serves the tools over stdio; `wsp mcp install --agent <id>` writes the server into that agent's own MCP config, this skill into its skills folder, and wsp's own marked section into the instructions the folder it runs in keeps, `AGENTS.md` for every agent and `CLAUDE.md` beside it for Claude Code. A second run replaces that section where it stands, so there is only ever one and everything around it is untouched, a file whose end marker somebody deleted is repaired to that one section rather than given a second begin marker, and `wsp mcp install --agent <id> --remove` takes it back out, leaving the file's other lines byte for byte and the config and the skill where they are. `--agent` repeats to do several in one call, one failing id costing the others nothing, and off a terminal a run that names none takes every agent whose own command is on the PATH. `--json` answers with one line holding the `server` command every config now runs, what each agent took, its `docs` naming the files the section went into, and a `failures` array, a `provider` failure when that array is not empty. The prose ends on the one thing to do next, which is inside the agent that was just set up. An entry under `installed` with no `path` took the skill and not the server, which is the by-hand line the prose prints. Only agents the catalog knows an MCP config for get the server: claude, codex, gemini, opencode. The rest get the skill and a by-hand line.

### For a shell script

One verb is a shell script's and not an agent's, because it blocks: a script that starts threads and has to stand at the end of them has nothing else to do while they run.

| command line | MCP tool | what it does |
|---|---|---|
| `wsp threads wait <thread>... [--timeout <s>]` | `threads_wait` (threads, timeout) | blocks until one of the named threads leaves running and prints that thread's finished line, the one a notify sends to the person, with its id, status, duration, cost and the last line of its reply under `finished`; one thread per call, a thread already over comes back at once, and `--timeout` gives up after so many seconds with nothing on stdout, one stderr line and `timedOut` on the tool |

In your own conversation this is the wrong road: a blocked wait is minutes of your turn spent on nothing, and nothing can reach you while it runs. Start children with `--notify me` and end your turn instead when you are a thread, and hand a job of more than one turn to a coordinator thread when you are not; the two rules are the next section's.

## Running work on a workspace well

These decide whether work on a machine goes fast or stalls, and they hold on every workspace.

- A wsp thread starts every child with --notify me and ends its turn, and each child's finished line wakes it with that child's whole report, so nothing is polled and no turn is spent waiting. The launch environment says whether you are a thread, and `--notify me` resolves to whichever thread the request came out of.
- A caller that is not a wsp thread cannot be woken at all, so it takes the reply of one turn as the call returns, and hands work of more than one turn to a single coordinator thread on the local workspace, with the whole job in its brief and the person told where to read it.
- This computer is a workspace too, the one `wsp new --local` makes: put a quick subtask or a second harness on it, since it forks nothing, starts in a second, costs nothing and runs the agents already on this computer's PATH over the person's own files and sessions. Fork a cloud workspace for builds that run beside each other, for anything that should not touch this computer, and for a disk you can snapshot and hand to the next workspace.
- Snapshot a workspace once a project's dependencies are installed on it: `wsp snapshot <workspace>` keeps that disk as a project golden, and `wsp new <name> --from <that golden>` starts every later workspace with the install already there, so no thread installs the same dependencies twice.
- One heavy thread per machine: on 2 vCPU and 4 GB one thread runs tests or a build at a time and a second thread is a light send. Three test runs at once starve the machine and every turn in flight fails.
- A thread that builds gets its own git worktree, which is how two threads share one machine, and that worktree's setup is made cheap rather than skipped: pnpm's side-effects cache so a native module is compiled once per machine, and the checkout's `node_modules` hardlinked into the new worktree before `pnpm install --offline`, which then only verifies. A worktree set up from scratch relinks thousands of files and rebuilds native modules, minutes on 2 vCPU.
- `wsp send <thread>` continues a thread that has already replied; a send into a thread whose turn is still running opens no second turn and is a mistake. Wait for the turn to end, or `wsp stop <thread>` first.
- Restarting the host cuts every turn running on every workspace. Finish or stop the running turns before `wsp down` and `wsp up`.
- Pause a workspace nobody is using with `wsp pause <workspace>`: a sleeping machine costs nothing beyond its disk and gives back one of the two machines the account runs at once, and the next thread or command wakes it.
- The person's app and the command line read the same host, so every thread opened here shows in their sidebar and they read its reply there. Name each one with `--title` and keep the reply short and complete.

## The contract

The command line, the MCP tools and this skill are one contract: every capability exists in all three or in none, and the parity test in the repo holds them to it. With `--json`, stdout carries JSON alone: one JSON object per line, frames first, the last line is the result; a verb with no stream prints the result alone. The result is the object the MCP tool of the same name answers with, less what the frames already carried, so no line prints twice: `wsp exec --json` prints one `exec.output` frame per output line and then a result with the exit code and the folder; `wsp import --json` prints the plan and then `{"imported": ...}`, or the plan alone when nothing was imported; `wsp fork dev --send "<task>" --json` prints the creating frames, the workspace and then `{"turn": ...}`. Without `--json`, stdout is for a person. Progress, the waking line and every refusal go to stderr. A refusal or a failure is one line on stderr, the failure object `{"error": "<the line>", "class": "usage", "exit": 3}` under `--json`, and the exit code is the class's:

| exit | class | when |
|---|---|---|
| 0 | `ok` | it did what its line says; with --json stdout holds the answer |
| 1 | `provider` | the host, the runtime, Solari or the machine refused or failed |
| 2 | `auth` | no key, no sign-in, or the host refused the token |
| 3 | `usage` | the line was refused before anything ran: a missing argument, an unknown flag or a value nothing takes |

`wsp exec` is the one exception: its exit code is the command's own, and only a machine that could not run it is a `provider` failure. A person saying no to a confirmation is `<name> kept` on stderr with exit code 1. An MCP tool answers a failure as a tool error whose structured content is the same object, so `class` reads the same on both doors; a call whose inputs do not fit the tool's schema is refused by the server before the tool runs.

### thread new

```
wsp projects dev                                   # the projects on dev, by name; the name is what --project takes
wsp thread new --in dev --project wsp --notify me "Read ticket 308 ... and build it."
wsp thread new --in dev --model claude-sonnet-5 --effort low --access plan "Review the branch ticket/308."
wsp thread new --in mac --agent codex "Say in one line which folder you are in and what is in it."
```

`--in` takes any workspace `wsp workspaces` lists, this computer included (`mac` above, whatever the local workspace is named): a thread there runs the agent already on this computer's PATH, keeps its session in the person's own agent folder, and nothing is forked or woken for it. Without `--in`, run from inside a repo one of the workspaces holds as a project (by path on this computer, by the folder's name on a fork), the thread goes to the workspace that project last ran on, in that project, and the first line printed says where: `thread 1a2b3c4d on b2 in ~/spoo`. Outside a repo, or in one no workspace holds, it is refused in one line and nothing starts; over MCP the same happens from the folder the agent started the server in. Its folder is the workspace's own rather than the person's home, so a thread never opens on their files by accident. `--agent` names the agent to run in the thread; the host's default is claude, and a thread runs only on an agent the host has an adapter for; a refusal names the ones it has. `--model`, `--effort` and `--access` pick the model, the reasoning effort and the access mode by the agent's own words (`claude-sonnet-5`; `low`, `medium`, `high`, `xhigh`, `max`; `plan`, `acceptEdits`, `bypassPermissions`), the same three the app's composer offers; absent, the agent's catalog defaults run (`high` for claude), and a value the catalog does not list is refused before anything starts, naming the list. A cheaper model for a review is the usual pick. `--project` names one of the workspace's projects, the ones `wsp projects <workspace>` lists, and the thread starts in that project's folder; a name the workspace lacks is refused naming the ones it has, before anything is woken. Name the project, not its path. `--cwd` is an absolute path on the machine and wins over `--project`; with neither, the thread starts in the project the last thread on that workspace used, else in the workspace's only project, else in the workspace's own folder, which on a fork is the machine's home folder. The same rule fills the app's project pick, so a thread opened here starts where one opened there would. A thread's folder decides which project state (sessions, memory, CLAUDE.md) the agent loads, so put a thread where its project is. `--title` names the thread, as a person naming it does: the name shows in the sidebar and in the agent's own session list at once, and the title the host asks the agent for as the turn starts never replaces it. Without one the thread is titled by its opening words for the few seconds the agent takes to name it, and by that name after. `--notify me` names the caller: the thread you are when the host launched you as one, and the person when it did not, which is how a thread starts a child without knowing its own id. `--notify <thread>` names another thread outright. Either way the line goes into that thread as a message (steered into its running turn or queued), and a line the person gets shows in their app. The notify line goes once, at the reply. The person's line reads `thread 1a2b3c4d finished (completed, 12m 4s, $0.41): <last line of the reply>`; a thread's carries the same facts and then the child's final message whole, so you act on the report without reading anything else. A `--notify me` from a turn that has ended, or with a token this host never launched, is refused rather than sent to the person.

`--notify` repeats, and each target gets the line once: `--notify me --notify 5e6f7a8b` wires a builder's end to you and to a reviewer thread together, and the reviewer's own end back to the builder and to you. That removes the relay you would do by hand; it decides nothing, so you still read every report and make the calls. A target whose thread is gone by the time the child ends falls back to the person, and the new thread's own id as a target is refused.

The command line streams the reply to stderr as it arrives and prints the last message on stdout when the reply is complete; a failed turn is a `provider` failure, its reason the one line on stderr. With `--detach` (`detach` true on the tool) nothing streams: the thread id is the whole answer, the turn runs on, and its end goes to whoever `--notify` named (see the notify paragraph above). A turn ends when the agent process exits, not at its reply, and the thread reads running until then, which can be minutes when the agent left a command running; a `send` before then waits for that process and runs as the next turn (see send). The first stdout line is `thread <id>`, the id `send` takes. The MCP tool returns the reply text with the thread id, workspace id, agent and outcome. When the thread's previous turn did not finish (a deadline, a host restart, a nap), the reply text from `send` and `thread_new` opens with the line `previous turn was cut; resuming` and the structured output carries `afterCut: true`, and the command line prints that line on stderr before the reply; the agent then resumes a transcript that may be missing its last steps, so restate what matters.

### send

```
wsp send 1a2b3c4d "Also cover the codex case in the test."
wsp send 1a2b3c4d --model claude-opus-5 --effort high "Now the hard part."
```

A send is never refused for meeting a turn. Into a thread whose turn is not running the message starts a new turn (outcome `started`), on the model, effort and access named or the thread's own. Into a thread whose turn is running: when the agent can take input mid-turn (Claude Code does) the message joins the running turn (outcome `steered`) and arrives at that turn's next tool round, the way a person's message does, and the reply is that turn's, on that turn's picks; otherwise the message waits for the running turn to end and then runs (outcome `queued`). Into a thread whose turn has replied but whose agent process is still running, the message waits for that process and runs as the thread's next turn (outcome `queued`), which the host says as `thread 1a2b3c4d replied, still working; the message runs as its next turn once that process exits`; the app's composer shows the same words, and `threads` reads the thread running until the agent process exits. Two sends keep the order they arrived in. The command line says which outcome on stderr. A person's message on the same thread lands in order with yours. Never start a second thread to hurry a running one.

Threads talk to each other, and this is the road: `wsp send <thread> "<message>"` (the `send` tool) puts your words into another thread by its id, whoever opened it, and `wsp threads` (the `threads` tool) is where you find that id, with the workspace, the agent and the title beside it. The other thread's answer does not come back to this call: it comes back as its own next message when that thread was started with `--notify me` naming you, or with `--notify <your thread>`. So a thread asking another thread something starts it with a notify that names the asker, sends, and ends its turn.

### threads wait

```
wsp thread new --in dev --detach --notify me --title "413 build" "Read ticket 413 ... and build it."
wsp threads wait 1a2b3c4d 5e6f7a8b --timeout 600
```

`--detach` on `thread new` and `send` (`detach` true on `thread_new` and `send`) prints `thread <id>` the moment the turn is started and returns; the turn runs on. `threads wait` then blocks until one of the named threads leaves running and prints that thread's finished line, `thread 1a2b3c4d finished (completed, 12m 4s, $0.41): <last line of the reply>`, the same line a `--notify` sends to the person, and under `--json` and on the tool the id, status, duration, cost and the reply's last line under `finished`. One thread per call: a script that started three builders calls it three times, dropping each returned id from the list, since a thread already over comes back at once and would come back again. `--timeout <s>` (`timeout`, seconds) gives up after that long: nothing on stdout, `thread 1a2b3c4d still running after 10m` on stderr (`timedOut` true on the tool) and the `ok` exit code, since nothing failed, so other work fits between calls. This is a shell script's verb: a script has nothing else to do while its builders run, and a person is reading its output. Do not call it in your own conversation, where it spends minutes of a turn on nothing and nothing can reach you meanwhile. Never poll `threads` for a state change either: a thread starts its children with `--notify me`, and a caller that is not a thread hands more than one turn's work to a coordinator thread.

### stop

```
wsp stop 1a2b3c4d
```

Ends the thread's running turn through the runtime, the way the app's stop button does; the turn ends with status interrupted and whoever followed it gets `turn interrupted`. The line says `thread <id> stopped`, or `thread <id> not running` when the turn had already ended; both succeed, since neither is an error. The machine is not paused or killed and the thread takes the next `send`. Use it when a `send` started a turn you did not mean to, instead of pausing the workspace.

### exec

```
wsp exec dev -- git status --short
wsp exec dev --cwd /root -- sh -c 'ls | wc -l'
```

Each word after `--` reaches the machine as one argument; a shell line goes through `sh -c`. The command runs in the folder `--cwd` names (absolute, on the machine), else in the workspace's imported project folder when it has one, else in the workspace's own folder, which on a fork is the machine's home folder, so `git status` on a workspace with a project needs no `cd`. The command's exit code is the verb's, and a non-zero exit is followed by one stderr line naming the folder it ran in, which the host answers with rather than the caller assuming it; the tool carries that folder as `cwd`. A non-zero exit is a result; the machine going away is an error. The machine runs as root with home /root and no login shell, so `bash -c`, never `bash -lc`.

### new, fork, snapshot

```
wsp snapshot dev                      # project golden of dev: its golden plus the imported project
wsp new dev-2 --from wsp              # a machine from that project golden, every project it carried in place, no upload; the created line names them
wsp fork dev --send "Run the gate."   # a sibling machine from dev's golden version, first thread opened
wsp new gate --size 2x8               # a machine at a size the provider offers; the refusal lists them
```

`fork` copies the golden version, not the live disk: work on the source's disk is not on the fork. Fork from a project golden when the fork needs the project. When a fork's first turn fails, the workspace still exists and the error names it; continue with `thread new` on it, do not fork again. `snapshot` takes only a running first-life machine with a project imported; a woken machine or one without a project is refused in one line and nothing is taken.

### import

```
wsp folders /Users/zingzy                        # what is inside, for naming a folder to import
wsp import /Users/zingzy/wsp --to dev            # the plan; a person is asked once, a pipe or an agent gets the plan and nothing moves
wsp import /Users/zingzy/wsp --to dev --yes      # the plan's defaults: secret-shaped files cut, rewrites taken, sessions of every listed agent
wsp import /Users/zingzy/wsp --to dev --keep .env --agents claude
wsp import /Users/zingzy/wsp --to mac                    # this computer: the path is registered, nothing is copied, nothing is asked
wsp import /Users/zingzy/wsp                             # no --to: the workspace the last thread started on, said on stderr
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
3. The brief names the ticket, the files to read whole, the laws (the repo's review skill), the exact test commands and the proof required, and says to run every command in the foreground and wait for it, since a reply that lands with a command still running in the background reads failed, and the thread takes no send until that process exits. A brief that says "fix the bug" comes back with a guess.
4. Start builder threads with `--detach` (`detach` true on `thread_new`) and `--notify me`, which prints each thread's id and returns, then end your turn: each builder's finished line comes back to you as a message carrying its whole report, in the order they finish, and nothing is polled or waited on. When you are not a thread yourself and the job is more than one turn, this whole loop is a coordinator thread's on the local workspace: give it the job, hand off, and tell the person where to read it. Without `--detach`, `wsp thread new` and `thread_new` follow the first turn and return only at its reply, which is the right call for a short turn you read at once.
5. A review is its own thread on the same workspace with the branch name and the review skill; the builder fixes in its thread through `send`. A review runs well on a cheaper model, `--model` on thread new.
6. Work leaves the machine by `git push` from the thread (only when the golden signed in to GitHub during wsp init) or by `export` to this computer.
7. Gates (full test runs, builds, packaging) run on the person's machine or one at a time on the workspace. A 2 vCPU, 4 GB machine runs one build or one agent at a time; two starve the daemon and the app reads the machine as not answering.

## Where the person steps in

- Sign-ins happen on the machine during wsp init, and each page is opened and finished on the person's computer: the run hands it over and waits. A thread cannot sign in for them; if `gh auth status` fails on the machine, say so and export instead of pushing.
- Keys (the Solari key, an Anthropic key) live in the person's `.env` and never reach a thread. A secret a thread needs is asked for through wsp, not typed into a terminal.
- The account holds two machines at once. A third `new` or `fork` is refused; the person decides which workspace to pause.
- A pause or a wake that does not return is stuck on the provider side; tell the person rather than retrying in a loop.
- A workspace is the golden's size unless `new` or `fork` is given `--size`; a size the provider does not offer is refused in one line that names the ones it does, with the rate of each. A build or a test run wants the largest memory offered: on 4 GB one build starves the machine.
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

`wsp recipe` ticks catalog rows. A tool the person's projects use that the catalog has no row for and no package manager here installed goes on the image as its own row:

```
wsp recipe --add just="brew install just" --add-check just="just --version"
wsp recipe --add ruff="uv tool install ruff"
```

`--add <id>=<install command>` is repeatable and `--add-check <id>=<command>` says what proves the tool landed (without one, `command -v <id>`). The line runs on the machine as given, as root, after every catalog install, with Homebrew and apt already there. Rules for adding one:

- `--add` is for a tool this computer does not have. A package one of their own package managers already has is a row of its own: tick it with `--set`, not `--add`. An `--add` for one is refused in a line naming the `--set` word to use instead.
- Add only what the person's own history or their repository files show in use: a tool their agents ran that no manager here has, a runner their project's config names, a package the image needs and this computer never installed. Never add on a guess.
- Prefer a Homebrew, npm, uv or apt form (`brew install x`, `npm install -g x`, `uv tool install x`, `apt-get install -y x`) over a downloader. A line that pipes a download into a shell is refused in review.
- One tool per row, so a row that fails names the tool that failed. A failed row does not fail the build; it is listed as failed on the machine's lineage.
- There is no sign-in for these rows. A tool that needs a login needs a catalog row; say so instead of adding it.

## Packages this computer already has

Everything `wsp recipe scan` lists under Also on this Mac (`alsoHere` in the JSON) is a package one of their own managers installed, and each row's id there is the id to tick:

```
wsp recipe --set brew/zingzy/tap/diskbloom=on --set npm/turbo=off
```

Such a package is a row of its own, so the build installs it by the road the plan resolves for it: a formula with a Linux bottle by Homebrew, a tap formula with none from its GitHub release, pinned to the checksum its first install recorded, an npm or uv global by its manager. That is the same row and the same road the Also on this Mac screen ticks when the person drives the wizard, so an agent-written recipe and a hand-driven one build the same image. `--set <id>=off` unticks one again.

## Rules learned the hard way

- A send into a running thread steers it or waits behind it, never a second concurrent turn (#274).
- A thread's end reaches its parent thread or the person only when its start said `--notify`; nothing polls (#286).
- A thread starts its children with `--notify me`, which the host resolves to the thread the request came out of, and ends its turn; a caller that is not a thread cannot be reached by a line at all, so it takes one turn's reply or hands the job to a coordinator thread. `threads wait` blocks and belongs in a shell script (#413, #479).
- A thread works in `--cwd` or the workspace's project folder; a relative `--cwd` is refused before anything starts (#280).
- A turn ends on 10 minutes of silence, not a 15 minute wall clock; long steps must print (#295).
- A reply that lands with a command the agent left running in the background reads failed with the reason `ended with 1 background task running`, and nothing wakes the thread when that command finishes. Briefs say run every command in the foreground and wait for it (#313).
- `thread new` and `send` return when the reply is complete, not when the process exits minutes later; the thread reads running until the agent process exits, and a send that meets that gap waits for the process and runs as the thread's next turn rather than being refused (#293, #364, #479).
- A turn's process group dies with the turn; a server that must outlive it starts with `setsid nohup ... &` (#275).
- Snapshot only a running first-life machine with a project loaded; a woken machine is refused (#223).
- Export refuses an existing folder; `--replace` overwrites it on purpose (#224).
- A resumed thread runs in the folder its session started in, whatever folder is followed in the app (#236).
- A send carries its own request id, so two clients sending the same text do not adopt each other's turn (#239).
- The MCP server and the command line refuse a host of another version in one line; restart it with wsp up (#290).
- Not here yet: a GitHub credential on the machine outside a sign-in during init (#279).
