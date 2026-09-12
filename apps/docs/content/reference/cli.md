# Command line

Every verb, as `wsp --help` prints it. This page is generated from the binary at wsp 0.2.0; do not edit it by hand, run `pnpm --filter @wsp/docs cli` after the host changes.

Every verb takes `--json` for one JSON object per line, frames first and the result last, and `--state <path>` to name the state file the host serves. A refusal is one line on stderr and an exit code of its class: 0 ok, 1 provider, 2 auth, 3 usage. `wsp exec` exits with the command's own code.

```text
wsp - your setup, on cloud machines, for coding agents

usage:
  wsp up             start the app and the runtime over the golden you sealed
                     (plain wsp does the same). It serves until you stop it, so
                     closing that terminal takes the app down with it; --service
                     hands the same line to this computer's own service manager
                     instead, which starts it now and again at every login
  wsp down           stop the service and take it away, so nothing brings the
                     host back at the next login
  wsp status         whether a host is serving this state file, on which ports,
                     and what keeps it there, with a non-zero exit code when
                     none does
  wsp init           set up your first golden image one screen at a time:
                     Agents, Tools, Also on this computer, Sign-ins, wsp for
                     your agents on this computer, each shown when it has a
                     row to pick, then Build, then the browser. With no
                     provider key it seals nothing and makes this computer
                     your workspace instead
  wsp doctor         run the reach loop end to end against one live machine
                     (--yes also deletes the snapshots this host left behind);
                     --local proves the other half instead, a thread on this
                     computer and its reply, with no machine and no key
  wsp mcp            serve the verbs as MCP tools over stdio to an agent on this
                     computer; wsp mcp install --agent <id> puts the server in
                     that agent's own MCP config (claude, codex, gemini, opencode),
                     the wsp skill in its skills folder, and wsp's own section
                     in this folder's AGENTS.md, which --remove takes back out.
                     --agent repeats and off a terminal every agent on your PATH
                     takes it; --json prints one line holding what each agent
                     took and a failures array for the ones that took nothing;
                     all three are read by mcp install alone
  wsp --version      print the version

verbs; every one takes --json for its raw values. The recipe verbs read this
computer and write beside the state file; the rest speak to the host wsp up
started:
  wsp workspaces
      every workspace this host runs: what its machine is, its state as the
      sidebar shows it (running, paused, waking or unreachable, off the phase
      with the provider's word for the machine and the daemon reach beside it)
      where the kind has one, and how many projects it holds
  wsp projects <workspace>
      the projects on the workspace, oldest import first: name, folder on the
      machine, size and when it landed; the name is what thread new --project
      takes
  wsp threads [--in <workspace>]
      every thread as the sidebar lists it: agent, state, who opened it, the
      folder it works in
  wsp threads wait <thread>... [--timeout <s>]
      blocks until one of the threads leaves running and prints its finished
      line, the one a notify sends; --timeout gives up after so many seconds and
      says so on stderr
  wsp recipe scan [--project <folder>]
      read this computer and print every option, writing nothing: the agents,
      the tools with why and size, what else a package manager here has that the
      image could take, the commands your agents ran, and the sign-ins, each
      with what to do about it and one line of why; --project weighs the
      histories by a folder and --json prints it as one object
  wsp recipe [--tick used|installed|default] [--set <id>=on|off]
    [--signin <id>=copy|machine|key|skip] [--add <id>=<command>]
    [--add-check <id>=<command>] [--project <folder>] [--out <path>]
      write the recipe and print it as a table: every catalog agent and tool
      with its tick, why it has it and what it costs on the machine, then the
      commands your agents ran that no catalog row carries. --tick
      used|installed|default names the rule that decides every tick (used, the
      default, ticks what your agents actually ran here); --set <id>=on|off
      flips a row by its catalog id, or a package this computer's own package
      managers have by the id wsp recipe scan gives it, which the build installs
      by that package's own road; --signin <id>=copy|machine|key|skip answers a
      sign-in by catalog id, key bringing the key files beside a login and
      nothing else of it; --add <id>=<command> carries a tool neither the
      catalog nor this computer has, installed by that command on the machine,
      with --add-check <id>=<command> saying it is there; --project reads a
      folder's own manifests for what it takes to build and weighs the histories
      by it, --out says where the file goes and --json prints the table as one
      object. Naming --tick or --project decides every tick again; without
      either, what the file says stands and the flags flip rows on top of it. A
      sign-in answer stands either way: no rule decides one. All of them repeat.
      Review it, then wsp init --recipe
  wsp new <name> [--from <project golden>] [--size <cpu>x<memGb>] | wsp new
    --local [name] | wsp new --ssh <user@host> [name] [--ssh-port <port>]
    [--ssh-key <path>]
      a workspace from the golden's head or, with --from, a project golden;
      --local is this computer, --ssh a machine of your own
  wsp rename <workspace> "<name>"
      names the workspace on this computer; the name is unique here, so one
      another workspace holds is refused
  wsp snapshot <workspace>
      a project golden of the workspace: its golden plus the project as it is
      now, ready to fork
  wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>]
    [--send "<task>" [thread new's flags]]
      a new machine from the source's golden version, not a copy of its live
      disk; --size as new's
  wsp pause <workspace>
      naps the workspace's machine
  wsp wake <workspace>
      wakes the workspace's machine and prints its state once the runtime has
      answered
  wsp rebuild <workspace>
      replaces a gone workspace's machine from its image and prints the state of
      the new one
  wsp image move <workspace>
      moves the workspace onto the newest version of its image and prints what
      of the image's own files it kept
  wsp forget <workspace> [--yes]
      drops a gone workspace and its threads from this computer; refused while
      its machine exists
  wsp delete <workspace> [--yes]
      deletes the machine at the provider, then drops the record and threads
      from this computer
  wsp thread new [--in <workspace>]
    [--agent, --model, --effort, --access, --project <name>, --cwd, --notify, -…
    "<task>"
      opens a thread with the agent, model, effort and access the app offers, in
      the project named or the one the app's pick would take; without --in, run
      from inside a registered repo, on the workspace that project last ran on;
      follows its first turn, or with --detach prints the id and returns
  wsp thread read <thread> [--last]
      the thread's messages as the app lists them, oldest first: who each one
      is, when the runtime recorded it and the text, with every tool call folded
      to the one line the app's row reads; --last prints the final reply alone,
      the whole message its finished line carries. A tool's output and the
      agent's reasoning are no rows of it
  wsp thread rename <thread> "<title>"
      names the thread inside the agent's own store, so the agent shows the same
      name
  wsp send <thread> [--model, --effort, --access <value>] [--image <path>]
    [--detach] "<message>"
      a message to the thread, on a named model, effort or access, with images;
      a running turn keeps its own; --detach prints the id and returns
  wsp stop <thread>
      stops the thread's running turn, as the app's stop does; the machine stays
      up
  wsp exec <workspace> [--cwd <dir>] -- <command...>
      runs the command on the machine, each word as given, in --cwd or the
      folder a thread would start in
  wsp folders [<folder>] [--hidden]
      the folders inside one folder on this computer, for naming one to import;
      the home folder and every imported project are the roots and nothing
      outside them is listed
  wsp import <folder> [--to <workspace>] [--yes] [--keep, --cut <path>]
    [--agents <ids>] [--replace]
      lands a folder on the machine at its path here; the plan first, then --yes
      or one question; on this computer it registers the path and copies
      nothing; without --to, the workspace the last thread started on
  wsp setup
      the cloud setup on this host as the app's Set up cloud machines modal
      reads it: which keys are held (never their values), the agents here, what
      a machine costs, and the init job's phase, rows and progress when one runs
      or ran
  wsp terminal config [--scheme light|dark]
      the Ghostty config on this computer as the app's terminal pane applies it,
      read from ~/.config/ghostty and Application Support with its includes and
      theme resolved: the font and its fallbacks, the size, the colors, the
      cursor, the padding, the background opacity, and the blur, which is read
      but not applied; --scheme picks the side of a light:...,dark:... theme
  wsp export <workspace> <folder> [--from <path on the machine>] [--replace]
    [--agents <ids>]
      brings a project folder and the agent sessions keyed to it home from the
      machine

  wsp send streams the reply to stderr as it arrives and prints the last message
  on stdout when the reply is complete.
  A turn ends when the agent process exits, not at its reply, and the thread
  reads running until then.
  wsp exec streams the command's output and exits with its code. thread new,
  send and exec wake a paused workspace first, with one line on stderr saying so.

exit codes; every failure is one line on stderr, the failure object with --json:
  0 ok        it did what its line says; with --json stdout holds the answer
  1 provider  the host, the runtime, Solari or the machine refused or failed
  2 auth      no key, no sign-in, or the host refused the token
  3 usage     the line was refused before anything ran: a missing argument, an
              unknown flag or a value nothing takes

options:
  --port N           app port (default 4400); the runtime websocket
                     port follows 10 above it
  --ws-port N        runtime websocket port on its own (default
                     4410); --port alone moves both
  --state PATH       state file: this word first, else WSP_HOME's state.json,
                     else ./.wsp/state.json when the current directory has a
                     .env, else state.json in the home the running host serves,
                     which is ~/.wsp unless current-home names another
  --yes              init: take every default and ask nothing (required off a
                     terminal); a login with a browser or device sign-in, or one
                     held in the Keychain, defaults to sign in on the machine
                     unless a saved recipe answered copy, so macOS has nothing
                     to ask either and the sign-ins wait for the app's terminal.
                     doctor: also delete the snapshots and templates this host
                     left behind, which is not reversible
  --recipe PATH      init: tick the agents and tools from this recipe (wsp recipe
                     writes it; init writes <state dir>/recipe.json too) and go
                     straight to the sign-ins; this machine is still read for
                     what travels
  --project PATH     init: the project folder you are bringing first. Its own
                     files (package.json, the lockfiles, pyproject, go.mod,
                     Cargo.toml, the compose files, .tool-versions, the CI
                     workflows) say what it needs, and those rows are ticked
                     first, each saying which file asked. Without it, init asks
                     for one before the first screen
  --first-workspace NAME
                     init: fork the first workspace under this name once the
                     golden seals, without asking (default first). A run with
                     nobody at a terminal forks nothing unless this or --import
                     asks for it
  --import FOLDER    init: import this folder's project onto that first
                     workspace, with the consent the app's import starts from:
                     caches left behind, secret-shaped files cut unless a
                     rewrite drops their credentials, and the sessions your
                     agents have for the folder travelling with it
  --no-local         init: leave this computer alone. The workspace step ticks
                     it by default, since a workspace here forks nothing and
                     bills nothing; this is the one way to end an init without
                     one. Refused on a run with no provider key, where it is
                     the only workspace there is
  --local            doctor: prove a thread on this computer and its reply
                     instead of the reach loop, which needs no provider key,
                     forks nothing and bills nothing
  --non-interactive  init: ask nothing, but still run the sign-ins on the
                     machine: each one prints the page to open on this computer,
                     the code when the flow shows one, and the command that
                     opens it, then waits for you (this is what a run off a
                     terminal does anyway). The run ends with the golden
                     recorded and never serves the app; wsp up does that
  --service          up: install the host as a launchd agent on a Mac, or a
                     systemd user unit on Linux, and wait for it to answer on
                     its port. The keys are not written into it: the service
                     reads the same .env a terminal run reads, so they have to
                     be in a file rather than exported in the shell that
                     installs it. It does pin the node and the wsp it was run
                     from by path, so a node that goes away later (an nvm
                     switch, a brew upgrade) stops the service at the next
                     login, with its log the only place that says why
  --json             init: print each build stage frame (with the install step
                     it belongs to, the command that step runs and its seconds
                     so far), each sign-in hand-off and its outcome as one JSON
                     object on stdout, then one last object naming the golden,
                     the recipe, the wsp up to run next and, unless
                     --first-workspace or --import asked for one, the wsp new
                     that forks a workspace; everything else on stderr. Implies
                     --non-interactive, and is refused beside --yes, which skips
                     the sign-ins

keys are read from the environment, then ./.env, then ~/.wsp/.env (WSP_HOME
overrides ~/.wsp). The prompt runs only when no Solari key is found; it asks
for the optional Anthropic key at the same time and can save both to that file.
With a Solari key present, a missing Anthropic key is only noted at start.
Without one, init and up take the local road: this computer is the workspace,
nothing is forked and nothing is sealed.
```

## wsp up

```text
wsp - your setup, on cloud machines, for coding agents

usage:
  wsp up             start the app and the runtime over the golden you sealed
                     (plain wsp does the same). It serves until you stop it, so
                     closing that terminal takes the app down with it; --service
                     hands the same line to this computer's own service manager
                     instead, which starts it now and again at every login
  wsp down           stop the service and take it away, so nothing brings the
                     host back at the next login
  wsp status         whether a host is serving this state file, on which ports,
                     and what keeps it there, with a non-zero exit code when
                     none does
  wsp init           set up your first golden image one screen at a time:
                     Agents, Tools, Also on this computer, Sign-ins, wsp for
                     your agents on this computer, each shown when it has a
                     row to pick, then Build, then the browser. With no
                     provider key it seals nothing and makes this computer
                     your workspace instead
  wsp doctor         run the reach loop end to end against one live machine
                     (--yes also deletes the snapshots this host left behind);
                     --local proves the other half instead, a thread on this
                     computer and its reply, with no machine and no key
  wsp mcp            serve the verbs as MCP tools over stdio to an agent on this
                     computer; wsp mcp install --agent <id> puts the server in
                     that agent's own MCP config (claude, codex, gemini, opencode),
                     the wsp skill in its skills folder, and wsp's own section
                     in this folder's AGENTS.md, which --remove takes back out.
                     --agent repeats and off a terminal every agent on your PATH
                     takes it; --json prints one line holding what each agent
                     took and a failures array for the ones that took nothing;
                     all three are read by mcp install alone
  wsp --version      print the version

verbs; every one takes --json for its raw values. The recipe verbs read this
computer and write beside the state file; the rest speak to the host wsp up
started:
  wsp workspaces
      every workspace this host runs: what its machine is, its state as the
      sidebar shows it (running, paused, waking or unreachable, off the phase
      with the provider's word for the machine and the daemon reach beside it)
      where the kind has one, and how many projects it holds
  wsp projects <workspace>
      the projects on the workspace, oldest import first: name, folder on the
      machine, size and when it landed; the name is what thread new --project
      takes
  wsp threads [--in <workspace>]
      every thread as the sidebar lists it: agent, state, who opened it, the
      folder it works in
  wsp threads wait <thread>... [--timeout <s>]
      blocks until one of the threads leaves running and prints its finished
      line, the one a notify sends; --timeout gives up after so many seconds and
      says so on stderr
  wsp recipe scan [--project <folder>]
      read this computer and print every option, writing nothing: the agents,
      the tools with why and size, what else a package manager here has that the
      image could take, the commands your agents ran, and the sign-ins, each
      with what to do about it and one line of why; --project weighs the
      histories by a folder and --json prints it as one object
  wsp recipe [--tick used|installed|default] [--set <id>=on|off]
    [--signin <id>=copy|machine|key|skip] [--add <id>=<command>]
    [--add-check <id>=<command>] [--project <folder>] [--out <path>]
      write the recipe and print it as a table: every catalog agent and tool
      with its tick, why it has it and what it costs on the machine, then the
      commands your agents ran that no catalog row carries. --tick
      used|installed|default names the rule that decides every tick (used, the
      default, ticks what your agents actually ran here); --set <id>=on|off
      flips a row by its catalog id, or a package this computer's own package
      managers have by the id wsp recipe scan gives it, which the build installs
      by that package's own road; --signin <id>=copy|machine|key|skip answers a
      sign-in by catalog id, key bringing the key files beside a login and
      nothing else of it; --add <id>=<command> carries a tool neither the
      catalog nor this computer has, installed by that command on the machine,
      with --add-check <id>=<command> saying it is there; --project reads a
      folder's own manifests for what it takes to build and weighs the histories
      by it, --out says where the file goes and --json prints the table as one
      object. Naming --tick or --project decides every tick again; without
      either, what the file says stands and the flags flip rows on top of it. A
      sign-in answer stands either way: no rule decides one. All of them repeat.
      Review it, then wsp init --recipe
  wsp new <name> [--from <project golden>] [--size <cpu>x<memGb>] | wsp new
    --local [name] | wsp new --ssh <user@host> [name] [--ssh-port <port>]
    [--ssh-key <path>]
      a workspace from the golden's head or, with --from, a project golden;
      --local is this computer, --ssh a machine of your own
  wsp rename <workspace> "<name>"
      names the workspace on this computer; the name is unique here, so one
      another workspace holds is refused
  wsp snapshot <workspace>
      a project golden of the workspace: its golden plus the project as it is
      now, ready to fork
  wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>]
    [--send "<task>" [thread new's flags]]
      a new machine from the source's golden version, not a copy of its live
      disk; --size as new's
  wsp pause <workspace>
      naps the workspace's machine
  wsp wake <workspace>
      wakes the workspace's machine and prints its state once the runtime has
      answered
  wsp rebuild <workspace>
      replaces a gone workspace's machine from its image and prints the state of
      the new one
  wsp image move <workspace>
      moves the workspace onto the newest version of its image and prints what
      of the image's own files it kept
  wsp forget <workspace> [--yes]
      drops a gone workspace and its threads from this computer; refused while
      its machine exists
  wsp delete <workspace> [--yes]
      deletes the machine at the provider, then drops the record and threads
      from this computer
  wsp thread new [--in <workspace>]
    [--agent, --model, --effort, --access, --project <name>, --cwd, --notify, -…
    "<task>"
      opens a thread with the agent, model, effort and access the app offers, in
      the project named or the one the app's pick would take; without --in, run
      from inside a registered repo, on the workspace that project last ran on;
      follows its first turn, or with --detach prints the id and returns
  wsp thread read <thread> [--last]
      the thread's messages as the app lists them, oldest first: who each one
      is, when the runtime recorded it and the text, with every tool call folded
      to the one line the app's row reads; --last prints the final reply alone,
      the whole message its finished line carries. A tool's output and the
      agent's reasoning are no rows of it
  wsp thread rename <thread> "<title>"
      names the thread inside the agent's own store, so the agent shows the same
      name
  wsp send <thread> [--model, --effort, --access <value>] [--image <path>]
    [--detach] "<message>"
      a message to the thread, on a named model, effort or access, with images;
      a running turn keeps its own; --detach prints the id and returns
  wsp stop <thread>
      stops the thread's running turn, as the app's stop does; the machine stays
      up
  wsp exec <workspace> [--cwd <dir>] -- <command...>
      runs the command on the machine, each word as given, in --cwd or the
      folder a thread would start in
  wsp folders [<folder>] [--hidden]
      the folders inside one folder on this computer, for naming one to import;
      the home folder and every imported project are the roots and nothing
      outside them is listed
  wsp import <folder> [--to <workspace>] [--yes] [--keep, --cut <path>]
    [--agents <ids>] [--replace]
      lands a folder on the machine at its path here; the plan first, then --yes
      or one question; on this computer it registers the path and copies
      nothing; without --to, the workspace the last thread started on
  wsp setup
      the cloud setup on this host as the app's Set up cloud machines modal
      reads it: which keys are held (never their values), the agents here, what
      a machine costs, and the init job's phase, rows and progress when one runs
      or ran
  wsp terminal config [--scheme light|dark]
      the Ghostty config on this computer as the app's terminal pane applies it,
      read from ~/.config/ghostty and Application Support with its includes and
      theme resolved: the font and its fallbacks, the size, the colors, the
      cursor, the padding, the background opacity, and the blur, which is read
      but not applied; --scheme picks the side of a light:...,dark:... theme
  wsp export <workspace> <folder> [--from <path on the machine>] [--replace]
    [--agents <ids>]
      brings a project folder and the agent sessions keyed to it home from the
      machine

  wsp send streams the reply to stderr as it arrives and prints the last message
  on stdout when the reply is complete.
  A turn ends when the agent process exits, not at its reply, and the thread
  reads running until then.
  wsp exec streams the command's output and exits with its code. thread new,
  send and exec wake a paused workspace first, with one line on stderr saying so.

exit codes; every failure is one line on stderr, the failure object with --json:
  0 ok        it did what its line says; with --json stdout holds the answer
  1 provider  the host, the runtime, Solari or the machine refused or failed
  2 auth      no key, no sign-in, or the host refused the token
  3 usage     the line was refused before anything ran: a missing argument, an
              unknown flag or a value nothing takes

options:
  --port N           app port (default 4400); the runtime websocket
                     port follows 10 above it
  --ws-port N        runtime websocket port on its own (default
                     4410); --port alone moves both
  --state PATH       state file: this word first, else WSP_HOME's state.json,
                     else ./.wsp/state.json when the current directory has a
                     .env, else state.json in the home the running host serves,
                     which is ~/.wsp unless current-home names another
  --yes              init: take every default and ask nothing (required off a
                     terminal); a login with a browser or device sign-in, or one
                     held in the Keychain, defaults to sign in on the machine
                     unless a saved recipe answered copy, so macOS has nothing
                     to ask either and the sign-ins wait for the app's terminal.
                     doctor: also delete the snapshots and templates this host
                     left behind, which is not reversible
  --recipe PATH      init: tick the agents and tools from this recipe (wsp recipe
                     writes it; init writes <state dir>/recipe.json too) and go
                     straight to the sign-ins; this machine is still read for
                     what travels
  --project PATH     init: the project folder you are bringing first. Its own
                     files (package.json, the lockfiles, pyproject, go.mod,
                     Cargo.toml, the compose files, .tool-versions, the CI
                     workflows) say what it needs, and those rows are ticked
                     first, each saying which file asked. Without it, init asks
                     for one before the first screen
  --first-workspace NAME
                     init: fork the first workspace under this name once the
                     golden seals, without asking (default first). A run with
                     nobody at a terminal forks nothing unless this or --import
                     asks for it
  --import FOLDER    init: import this folder's project onto that first
                     workspace, with the consent the app's import starts from:
                     caches left behind, secret-shaped files cut unless a
                     rewrite drops their credentials, and the sessions your
                     agents have for the folder travelling with it
  --no-local         init: leave this computer alone. The workspace step ticks
                     it by default, since a workspace here forks nothing and
                     bills nothing; this is the one way to end an init without
                     one. Refused on a run with no provider key, where it is
                     the only workspace there is
  --local            doctor: prove a thread on this computer and its reply
                     instead of the reach loop, which needs no provider key,
                     forks nothing and bills nothing
  --non-interactive  init: ask nothing, but still run the sign-ins on the
                     machine: each one prints the page to open on this computer,
                     the code when the flow shows one, and the command that
                     opens it, then waits for you (this is what a run off a
                     terminal does anyway). The run ends with the golden
                     recorded and never serves the app; wsp up does that
  --service          up: install the host as a launchd agent on a Mac, or a
                     systemd user unit on Linux, and wait for it to answer on
                     its port. The keys are not written into it: the service
                     reads the same .env a terminal run reads, so they have to
                     be in a file rather than exported in the shell that
                     installs it. It does pin the node and the wsp it was run
                     from by path, so a node that goes away later (an nvm
                     switch, a brew upgrade) stops the service at the next
                     login, with its log the only place that says why
  --json             init: print each build stage frame (with the install step
                     it belongs to, the command that step runs and its seconds
                     so far), each sign-in hand-off and its outcome as one JSON
                     object on stdout, then one last object naming the golden,
                     the recipe, the wsp up to run next and, unless
                     --first-workspace or --import asked for one, the wsp new
                     that forks a workspace; everything else on stderr. Implies
                     --non-interactive, and is refused beside --yes, which skips
                     the sign-ins

keys are read from the environment, then ./.env, then ~/.wsp/.env (WSP_HOME
overrides ~/.wsp). The prompt runs only when no Solari key is found; it asks
for the optional Anthropic key at the same time and can save both to that file.
With a Solari key present, a missing Anthropic key is only noted at start.
Without one, init and up take the local road: this computer is the workspace,
nothing is forked and nothing is sealed.
```

## wsp init

```text
wsp - your setup, on cloud machines, for coding agents

usage:
  wsp up             start the app and the runtime over the golden you sealed
                     (plain wsp does the same). It serves until you stop it, so
                     closing that terminal takes the app down with it; --service
                     hands the same line to this computer's own service manager
                     instead, which starts it now and again at every login
  wsp down           stop the service and take it away, so nothing brings the
                     host back at the next login
  wsp status         whether a host is serving this state file, on which ports,
                     and what keeps it there, with a non-zero exit code when
                     none does
  wsp init           set up your first golden image one screen at a time:
                     Agents, Tools, Also on this computer, Sign-ins, wsp for
                     your agents on this computer, each shown when it has a
                     row to pick, then Build, then the browser. With no
                     provider key it seals nothing and makes this computer
                     your workspace instead
  wsp doctor         run the reach loop end to end against one live machine
                     (--yes also deletes the snapshots this host left behind);
                     --local proves the other half instead, a thread on this
                     computer and its reply, with no machine and no key
  wsp mcp            serve the verbs as MCP tools over stdio to an agent on this
                     computer; wsp mcp install --agent <id> puts the server in
                     that agent's own MCP config (claude, codex, gemini, opencode),
                     the wsp skill in its skills folder, and wsp's own section
                     in this folder's AGENTS.md, which --remove takes back out.
                     --agent repeats and off a terminal every agent on your PATH
                     takes it; --json prints one line holding what each agent
                     took and a failures array for the ones that took nothing;
                     all three are read by mcp install alone
  wsp --version      print the version

verbs; every one takes --json for its raw values. The recipe verbs read this
computer and write beside the state file; the rest speak to the host wsp up
started:
  wsp workspaces
      every workspace this host runs: what its machine is, its state as the
      sidebar shows it (running, paused, waking or unreachable, off the phase
      with the provider's word for the machine and the daemon reach beside it)
      where the kind has one, and how many projects it holds
  wsp projects <workspace>
      the projects on the workspace, oldest import first: name, folder on the
      machine, size and when it landed; the name is what thread new --project
      takes
  wsp threads [--in <workspace>]
      every thread as the sidebar lists it: agent, state, who opened it, the
      folder it works in
  wsp threads wait <thread>... [--timeout <s>]
      blocks until one of the threads leaves running and prints its finished
      line, the one a notify sends; --timeout gives up after so many seconds and
      says so on stderr
  wsp recipe scan [--project <folder>]
      read this computer and print every option, writing nothing: the agents,
      the tools with why and size, what else a package manager here has that the
      image could take, the commands your agents ran, and the sign-ins, each
      with what to do about it and one line of why; --project weighs the
      histories by a folder and --json prints it as one object
  wsp recipe [--tick used|installed|default] [--set <id>=on|off]
    [--signin <id>=copy|machine|key|skip] [--add <id>=<command>]
    [--add-check <id>=<command>] [--project <folder>] [--out <path>]
      write the recipe and print it as a table: every catalog agent and tool
      with its tick, why it has it and what it costs on the machine, then the
      commands your agents ran that no catalog row carries. --tick
      used|installed|default names the rule that decides every tick (used, the
      default, ticks what your agents actually ran here); --set <id>=on|off
      flips a row by its catalog id, or a package this computer's own package
      managers have by the id wsp recipe scan gives it, which the build installs
      by that package's own road; --signin <id>=copy|machine|key|skip answers a
      sign-in by catalog id, key bringing the key files beside a login and
      nothing else of it; --add <id>=<command> carries a tool neither the
      catalog nor this computer has, installed by that command on the machine,
      with --add-check <id>=<command> saying it is there; --project reads a
      folder's own manifests for what it takes to build and weighs the histories
      by it, --out says where the file goes and --json prints the table as one
      object. Naming --tick or --project decides every tick again; without
      either, what the file says stands and the flags flip rows on top of it. A
      sign-in answer stands either way: no rule decides one. All of them repeat.
      Review it, then wsp init --recipe
  wsp new <name> [--from <project golden>] [--size <cpu>x<memGb>] | wsp new
    --local [name] | wsp new --ssh <user@host> [name] [--ssh-port <port>]
    [--ssh-key <path>]
      a workspace from the golden's head or, with --from, a project golden;
      --local is this computer, --ssh a machine of your own
  wsp rename <workspace> "<name>"
      names the workspace on this computer; the name is unique here, so one
      another workspace holds is refused
  wsp snapshot <workspace>
      a project golden of the workspace: its golden plus the project as it is
      now, ready to fork
  wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>]
    [--send "<task>" [thread new's flags]]
      a new machine from the source's golden version, not a copy of its live
      disk; --size as new's
  wsp pause <workspace>
      naps the workspace's machine
  wsp wake <workspace>
      wakes the workspace's machine and prints its state once the runtime has
      answered
  wsp rebuild <workspace>
      replaces a gone workspace's machine from its image and prints the state of
      the new one
  wsp image move <workspace>
      moves the workspace onto the newest version of its image and prints what
      of the image's own files it kept
  wsp forget <workspace> [--yes]
      drops a gone workspace and its threads from this computer; refused while
      its machine exists
  wsp delete <workspace> [--yes]
      deletes the machine at the provider, then drops the record and threads
      from this computer
  wsp thread new [--in <workspace>]
    [--agent, --model, --effort, --access, --project <name>, --cwd, --notify, -…
    "<task>"
      opens a thread with the agent, model, effort and access the app offers, in
      the project named or the one the app's pick would take; without --in, run
      from inside a registered repo, on the workspace that project last ran on;
      follows its first turn, or with --detach prints the id and returns
  wsp thread read <thread> [--last]
      the thread's messages as the app lists them, oldest first: who each one
      is, when the runtime recorded it and the text, with every tool call folded
      to the one line the app's row reads; --last prints the final reply alone,
      the whole message its finished line carries. A tool's output and the
      agent's reasoning are no rows of it
  wsp thread rename <thread> "<title>"
      names the thread inside the agent's own store, so the agent shows the same
      name
  wsp send <thread> [--model, --effort, --access <value>] [--image <path>]
    [--detach] "<message>"
      a message to the thread, on a named model, effort or access, with images;
      a running turn keeps its own; --detach prints the id and returns
  wsp stop <thread>
      stops the thread's running turn, as the app's stop does; the machine stays
      up
  wsp exec <workspace> [--cwd <dir>] -- <command...>
      runs the command on the machine, each word as given, in --cwd or the
      folder a thread would start in
  wsp folders [<folder>] [--hidden]
      the folders inside one folder on this computer, for naming one to import;
      the home folder and every imported project are the roots and nothing
      outside them is listed
  wsp import <folder> [--to <workspace>] [--yes] [--keep, --cut <path>]
    [--agents <ids>] [--replace]
      lands a folder on the machine at its path here; the plan first, then --yes
      or one question; on this computer it registers the path and copies
      nothing; without --to, the workspace the last thread started on
  wsp setup
      the cloud setup on this host as the app's Set up cloud machines modal
      reads it: which keys are held (never their values), the agents here, what
      a machine costs, and the init job's phase, rows and progress when one runs
      or ran
  wsp terminal config [--scheme light|dark]
      the Ghostty config on this computer as the app's terminal pane applies it,
      read from ~/.config/ghostty and Application Support with its includes and
      theme resolved: the font and its fallbacks, the size, the colors, the
      cursor, the padding, the background opacity, and the blur, which is read
      but not applied; --scheme picks the side of a light:...,dark:... theme
  wsp export <workspace> <folder> [--from <path on the machine>] [--replace]
    [--agents <ids>]
      brings a project folder and the agent sessions keyed to it home from the
      machine

  wsp send streams the reply to stderr as it arrives and prints the last message
  on stdout when the reply is complete.
  A turn ends when the agent process exits, not at its reply, and the thread
  reads running until then.
  wsp exec streams the command's output and exits with its code. thread new,
  send and exec wake a paused workspace first, with one line on stderr saying so.

exit codes; every failure is one line on stderr, the failure object with --json:
  0 ok        it did what its line says; with --json stdout holds the answer
  1 provider  the host, the runtime, Solari or the machine refused or failed
  2 auth      no key, no sign-in, or the host refused the token
  3 usage     the line was refused before anything ran: a missing argument, an
              unknown flag or a value nothing takes

options:
  --port N           app port (default 4400); the runtime websocket
                     port follows 10 above it
  --ws-port N        runtime websocket port on its own (default
                     4410); --port alone moves both
  --state PATH       state file: this word first, else WSP_HOME's state.json,
                     else ./.wsp/state.json when the current directory has a
                     .env, else state.json in the home the running host serves,
                     which is ~/.wsp unless current-home names another
  --yes              init: take every default and ask nothing (required off a
                     terminal); a login with a browser or device sign-in, or one
                     held in the Keychain, defaults to sign in on the machine
                     unless a saved recipe answered copy, so macOS has nothing
                     to ask either and the sign-ins wait for the app's terminal.
                     doctor: also delete the snapshots and templates this host
                     left behind, which is not reversible
  --recipe PATH      init: tick the agents and tools from this recipe (wsp recipe
                     writes it; init writes <state dir>/recipe.json too) and go
                     straight to the sign-ins; this machine is still read for
                     what travels
  --project PATH     init: the project folder you are bringing first. Its own
                     files (package.json, the lockfiles, pyproject, go.mod,
                     Cargo.toml, the compose files, .tool-versions, the CI
                     workflows) say what it needs, and those rows are ticked
                     first, each saying which file asked. Without it, init asks
                     for one before the first screen
  --first-workspace NAME
                     init: fork the first workspace under this name once the
                     golden seals, without asking (default first). A run with
                     nobody at a terminal forks nothing unless this or --import
                     asks for it
  --import FOLDER    init: import this folder's project onto that first
                     workspace, with the consent the app's import starts from:
                     caches left behind, secret-shaped files cut unless a
                     rewrite drops their credentials, and the sessions your
                     agents have for the folder travelling with it
  --no-local         init: leave this computer alone. The workspace step ticks
                     it by default, since a workspace here forks nothing and
                     bills nothing; this is the one way to end an init without
                     one. Refused on a run with no provider key, where it is
                     the only workspace there is
  --local            doctor: prove a thread on this computer and its reply
                     instead of the reach loop, which needs no provider key,
                     forks nothing and bills nothing
  --non-interactive  init: ask nothing, but still run the sign-ins on the
                     machine: each one prints the page to open on this computer,
                     the code when the flow shows one, and the command that
                     opens it, then waits for you (this is what a run off a
                     terminal does anyway). The run ends with the golden
                     recorded and never serves the app; wsp up does that
  --service          up: install the host as a launchd agent on a Mac, or a
                     systemd user unit on Linux, and wait for it to answer on
                     its port. The keys are not written into it: the service
                     reads the same .env a terminal run reads, so they have to
                     be in a file rather than exported in the shell that
                     installs it. It does pin the node and the wsp it was run
                     from by path, so a node that goes away later (an nvm
                     switch, a brew upgrade) stops the service at the next
                     login, with its log the only place that says why
  --json             init: print each build stage frame (with the install step
                     it belongs to, the command that step runs and its seconds
                     so far), each sign-in hand-off and its outcome as one JSON
                     object on stdout, then one last object naming the golden,
                     the recipe, the wsp up to run next and, unless
                     --first-workspace or --import asked for one, the wsp new
                     that forks a workspace; everything else on stderr. Implies
                     --non-interactive, and is refused beside --yes, which skips
                     the sign-ins

keys are read from the environment, then ./.env, then ~/.wsp/.env (WSP_HOME
overrides ~/.wsp). The prompt runs only when no Solari key is found; it asks
for the optional Anthropic key at the same time and can save both to that file.
With a Solari key present, a missing Anthropic key is only noted at start.
Without one, init and up take the local road: this computer is the workspace,
nothing is forked and nothing is sealed.
```

## wsp recipe

```text
usage: wsp recipe [--tick used|installed|default] [--set <id>=on|off] [--signin <id>=copy|machine|key|skip] [--add <id>=<command>] [--add-check <id>=<command>] [--project <folder>] [--out <path>]
  write the recipe and print it as a table: every catalog agent and tool with
  its tick, why it has it and what it costs on the machine, then the commands
  your agents ran that no catalog row carries. --tick used|installed|default
  names the rule that decides every tick (used, the default, ticks what your
  agents actually ran here); --set <id>=on|off flips a row by its catalog id, or
  a package this computer's own package managers have by the id wsp recipe scan
  gives it, which the build installs by that package's own road; --signin
  <id>=copy|machine|key|skip answers a sign-in by catalog id, key bringing the
  key files beside a login and nothing else of it; --add <id>=<command> carries
  a tool neither the catalog nor this computer has, installed by that command on
  the machine, with --add-check <id>=<command> saying it is there; --project
  reads a folder's own manifests for what it takes to build and weighs the
  histories by it, --out says where the file goes and --json prints the table as
  one object. Naming --tick or --project decides every tick again; without
  either, what the file says stands and the flags flip rows on top of it. A
  sign-in answer stands either way: no rule decides one. All of them repeat.
  Review it, then wsp init --recipe

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp workspaces

```text
usage: wsp workspaces
  every workspace this host runs: what its machine is, its state as the sidebar
  shows it (running, paused, waking or unreachable, off the phase with the
  provider's word for the machine and the daemon reach beside it) where the kind
  has one, and how many projects it holds

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp threads

```text
usage: wsp threads [--in <workspace>]
  every thread as the sidebar lists it: agent, state, who opened it, the folder
  it works in

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp new

```text
usage: wsp new <name> [--from <project golden>] [--size <cpu>x<memGb>] | wsp new --local [name] | wsp new --ssh <user@host> [name] [--ssh-port <port>] [--ssh-key <path>]
  a workspace from the golden's head or, with --from, a project golden; --local
  is this computer, --ssh a machine of your own

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp fork

```text
usage: wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>] [--send "<task>" [thread new's flags]]
  a new machine from the source's golden version, not a copy of its live disk;
  --size as new's

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp snapshot

```text
usage: wsp snapshot <workspace>
  a project golden of the workspace: its golden plus the project as it is now,
  ready to fork

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp pause

```text
usage: wsp pause <workspace>
  naps the workspace's machine

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp wake

```text
usage: wsp wake <workspace>
  wakes the workspace's machine and prints its state once the runtime has
  answered

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp rename

```text
usage: wsp rename <workspace> "<name>"
  names the workspace on this computer; the name is unique here, so one another
  workspace holds is refused

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp forget

```text
usage: wsp forget <workspace> [--yes]
  drops a gone workspace and its threads from this computer; refused while its
  machine exists

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp delete

```text
usage: wsp delete <workspace> [--yes]
  deletes the machine at the provider, then drops the record and threads from
  this computer

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp thread

```text
wsp - your setup, on cloud machines, for coding agents

usage:
  wsp up             start the app and the runtime over the golden you sealed
                     (plain wsp does the same). It serves until you stop it, so
                     closing that terminal takes the app down with it; --service
                     hands the same line to this computer's own service manager
                     instead, which starts it now and again at every login
  wsp down           stop the service and take it away, so nothing brings the
                     host back at the next login
  wsp status         whether a host is serving this state file, on which ports,
                     and what keeps it there, with a non-zero exit code when
                     none does
  wsp init           set up your first golden image one screen at a time:
                     Agents, Tools, Also on this computer, Sign-ins, wsp for
                     your agents on this computer, each shown when it has a
                     row to pick, then Build, then the browser. With no
                     provider key it seals nothing and makes this computer
                     your workspace instead
  wsp doctor         run the reach loop end to end against one live machine
                     (--yes also deletes the snapshots this host left behind);
                     --local proves the other half instead, a thread on this
                     computer and its reply, with no machine and no key
  wsp mcp            serve the verbs as MCP tools over stdio to an agent on this
                     computer; wsp mcp install --agent <id> puts the server in
                     that agent's own MCP config (claude, codex, gemini, opencode),
                     the wsp skill in its skills folder, and wsp's own section
                     in this folder's AGENTS.md, which --remove takes back out.
                     --agent repeats and off a terminal every agent on your PATH
                     takes it; --json prints one line holding what each agent
                     took and a failures array for the ones that took nothing;
                     all three are read by mcp install alone
  wsp --version      print the version

verbs; every one takes --json for its raw values. The recipe verbs read this
computer and write beside the state file; the rest speak to the host wsp up
started:
  wsp workspaces
      every workspace this host runs: what its machine is, its state as the
      sidebar shows it (running, paused, waking or unreachable, off the phase
      with the provider's word for the machine and the daemon reach beside it)
      where the kind has one, and how many projects it holds
  wsp projects <workspace>
      the projects on the workspace, oldest import first: name, folder on the
      machine, size and when it landed; the name is what thread new --project
      takes
  wsp threads [--in <workspace>]
      every thread as the sidebar lists it: agent, state, who opened it, the
      folder it works in
  wsp threads wait <thread>... [--timeout <s>]
      blocks until one of the threads leaves running and prints its finished
      line, the one a notify sends; --timeout gives up after so many seconds and
      says so on stderr
  wsp recipe scan [--project <folder>]
      read this computer and print every option, writing nothing: the agents,
      the tools with why and size, what else a package manager here has that the
      image could take, the commands your agents ran, and the sign-ins, each
      with what to do about it and one line of why; --project weighs the
      histories by a folder and --json prints it as one object
  wsp recipe [--tick used|installed|default] [--set <id>=on|off]
    [--signin <id>=copy|machine|key|skip] [--add <id>=<command>]
    [--add-check <id>=<command>] [--project <folder>] [--out <path>]
      write the recipe and print it as a table: every catalog agent and tool
      with its tick, why it has it and what it costs on the machine, then the
      commands your agents ran that no catalog row carries. --tick
      used|installed|default names the rule that decides every tick (used, the
      default, ticks what your agents actually ran here); --set <id>=on|off
      flips a row by its catalog id, or a package this computer's own package
      managers have by the id wsp recipe scan gives it, which the build installs
      by that package's own road; --signin <id>=copy|machine|key|skip answers a
      sign-in by catalog id, key bringing the key files beside a login and
      nothing else of it; --add <id>=<command> carries a tool neither the
      catalog nor this computer has, installed by that command on the machine,
      with --add-check <id>=<command> saying it is there; --project reads a
      folder's own manifests for what it takes to build and weighs the histories
      by it, --out says where the file goes and --json prints the table as one
      object. Naming --tick or --project decides every tick again; without
      either, what the file says stands and the flags flip rows on top of it. A
      sign-in answer stands either way: no rule decides one. All of them repeat.
      Review it, then wsp init --recipe
  wsp new <name> [--from <project golden>] [--size <cpu>x<memGb>] | wsp new
    --local [name] | wsp new --ssh <user@host> [name] [--ssh-port <port>]
    [--ssh-key <path>]
      a workspace from the golden's head or, with --from, a project golden;
      --local is this computer, --ssh a machine of your own
  wsp rename <workspace> "<name>"
      names the workspace on this computer; the name is unique here, so one
      another workspace holds is refused
  wsp snapshot <workspace>
      a project golden of the workspace: its golden plus the project as it is
      now, ready to fork
  wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>]
    [--send "<task>" [thread new's flags]]
      a new machine from the source's golden version, not a copy of its live
      disk; --size as new's
  wsp pause <workspace>
      naps the workspace's machine
  wsp wake <workspace>
      wakes the workspace's machine and prints its state once the runtime has
      answered
  wsp rebuild <workspace>
      replaces a gone workspace's machine from its image and prints the state of
      the new one
  wsp image move <workspace>
      moves the workspace onto the newest version of its image and prints what
      of the image's own files it kept
  wsp forget <workspace> [--yes]
      drops a gone workspace and its threads from this computer; refused while
      its machine exists
  wsp delete <workspace> [--yes]
      deletes the machine at the provider, then drops the record and threads
      from this computer
  wsp thread new [--in <workspace>]
    [--agent, --model, --effort, --access, --project <name>, --cwd, --notify, -…
    "<task>"
      opens a thread with the agent, model, effort and access the app offers, in
      the project named or the one the app's pick would take; without --in, run
      from inside a registered repo, on the workspace that project last ran on;
      follows its first turn, or with --detach prints the id and returns
  wsp thread read <thread> [--last]
      the thread's messages as the app lists them, oldest first: who each one
      is, when the runtime recorded it and the text, with every tool call folded
      to the one line the app's row reads; --last prints the final reply alone,
      the whole message its finished line carries. A tool's output and the
      agent's reasoning are no rows of it
  wsp thread rename <thread> "<title>"
      names the thread inside the agent's own store, so the agent shows the same
      name
  wsp send <thread> [--model, --effort, --access <value>] [--image <path>]
    [--detach] "<message>"
      a message to the thread, on a named model, effort or access, with images;
      a running turn keeps its own; --detach prints the id and returns
  wsp stop <thread>
      stops the thread's running turn, as the app's stop does; the machine stays
      up
  wsp exec <workspace> [--cwd <dir>] -- <command...>
      runs the command on the machine, each word as given, in --cwd or the
      folder a thread would start in
  wsp folders [<folder>] [--hidden]
      the folders inside one folder on this computer, for naming one to import;
      the home folder and every imported project are the roots and nothing
      outside them is listed
  wsp import <folder> [--to <workspace>] [--yes] [--keep, --cut <path>]
    [--agents <ids>] [--replace]
      lands a folder on the machine at its path here; the plan first, then --yes
      or one question; on this computer it registers the path and copies
      nothing; without --to, the workspace the last thread started on
  wsp setup
      the cloud setup on this host as the app's Set up cloud machines modal
      reads it: which keys are held (never their values), the agents here, what
      a machine costs, and the init job's phase, rows and progress when one runs
      or ran
  wsp terminal config [--scheme light|dark]
      the Ghostty config on this computer as the app's terminal pane applies it,
      read from ~/.config/ghostty and Application Support with its includes and
      theme resolved: the font and its fallbacks, the size, the colors, the
      cursor, the padding, the background opacity, and the blur, which is read
      but not applied; --scheme picks the side of a light:...,dark:... theme
  wsp export <workspace> <folder> [--from <path on the machine>] [--replace]
    [--agents <ids>]
      brings a project folder and the agent sessions keyed to it home from the
      machine

  wsp send streams the reply to stderr as it arrives and prints the last message
  on stdout when the reply is complete.
  A turn ends when the agent process exits, not at its reply, and the thread
  reads running until then.
  wsp exec streams the command's output and exits with its code. thread new,
  send and exec wake a paused workspace first, with one line on stderr saying so.

exit codes; every failure is one line on stderr, the failure object with --json:
  0 ok        it did what its line says; with --json stdout holds the answer
  1 provider  the host, the runtime, Solari or the machine refused or failed
  2 auth      no key, no sign-in, or the host refused the token
  3 usage     the line was refused before anything ran: a missing argument, an
              unknown flag or a value nothing takes

options:
  --port N           app port (default 4400); the runtime websocket
                     port follows 10 above it
  --ws-port N        runtime websocket port on its own (default
                     4410); --port alone moves both
  --state PATH       state file: this word first, else WSP_HOME's state.json,
                     else ./.wsp/state.json when the current directory has a
                     .env, else state.json in the home the running host serves,
                     which is ~/.wsp unless current-home names another
  --yes              init: take every default and ask nothing (required off a
                     terminal); a login with a browser or device sign-in, or one
                     held in the Keychain, defaults to sign in on the machine
                     unless a saved recipe answered copy, so macOS has nothing
                     to ask either and the sign-ins wait for the app's terminal.
                     doctor: also delete the snapshots and templates this host
                     left behind, which is not reversible
  --recipe PATH      init: tick the agents and tools from this recipe (wsp recipe
                     writes it; init writes <state dir>/recipe.json too) and go
                     straight to the sign-ins; this machine is still read for
                     what travels
  --project PATH     init: the project folder you are bringing first. Its own
                     files (package.json, the lockfiles, pyproject, go.mod,
                     Cargo.toml, the compose files, .tool-versions, the CI
                     workflows) say what it needs, and those rows are ticked
                     first, each saying which file asked. Without it, init asks
                     for one before the first screen
  --first-workspace NAME
                     init: fork the first workspace under this name once the
                     golden seals, without asking (default first). A run with
                     nobody at a terminal forks nothing unless this or --import
                     asks for it
  --import FOLDER    init: import this folder's project onto that first
                     workspace, with the consent the app's import starts from:
                     caches left behind, secret-shaped files cut unless a
                     rewrite drops their credentials, and the sessions your
                     agents have for the folder travelling with it
  --no-local         init: leave this computer alone. The workspace step ticks
                     it by default, since a workspace here forks nothing and
                     bills nothing; this is the one way to end an init without
                     one. Refused on a run with no provider key, where it is
                     the only workspace there is
  --local            doctor: prove a thread on this computer and its reply
                     instead of the reach loop, which needs no provider key,
                     forks nothing and bills nothing
  --non-interactive  init: ask nothing, but still run the sign-ins on the
                     machine: each one prints the page to open on this computer,
                     the code when the flow shows one, and the command that
                     opens it, then waits for you (this is what a run off a
                     terminal does anyway). The run ends with the golden
                     recorded and never serves the app; wsp up does that
  --service          up: install the host as a launchd agent on a Mac, or a
                     systemd user unit on Linux, and wait for it to answer on
                     its port. The keys are not written into it: the service
                     reads the same .env a terminal run reads, so they have to
                     be in a file rather than exported in the shell that
                     installs it. It does pin the node and the wsp it was run
                     from by path, so a node that goes away later (an nvm
                     switch, a brew upgrade) stops the service at the next
                     login, with its log the only place that says why
  --json             init: print each build stage frame (with the install step
                     it belongs to, the command that step runs and its seconds
                     so far), each sign-in hand-off and its outcome as one JSON
                     object on stdout, then one last object naming the golden,
                     the recipe, the wsp up to run next and, unless
                     --first-workspace or --import asked for one, the wsp new
                     that forks a workspace; everything else on stderr. Implies
                     --non-interactive, and is refused beside --yes, which skips
                     the sign-ins

keys are read from the environment, then ./.env, then ~/.wsp/.env (WSP_HOME
overrides ~/.wsp). The prompt runs only when no Solari key is found; it asks
for the optional Anthropic key at the same time and can save both to that file.
With a Solari key present, a missing Anthropic key is only noted at start.
Without one, init and up take the local road: this computer is the workspace,
nothing is forked and nothing is sealed.
```

## wsp send

```text
usage: wsp send <thread> [--model, --effort, --access <value>] [--image <path>] [--detach] "<message>"
  a message to the thread, on a named model, effort or access, with images; a
  running turn keeps its own; --detach prints the id and returns

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp stop

```text
usage: wsp stop <thread>
  stops the thread's running turn, as the app's stop does; the machine stays up

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp exec

```text
usage: wsp exec <workspace> [--cwd <dir>] -- <command...>
  runs the command on the machine, each word as given, in --cwd or the folder a
  thread would start in

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp folders

```text
usage: wsp folders [<folder>] [--hidden]
  the folders inside one folder on this computer, for naming one to import; the
  home folder and every imported project are the roots and nothing outside them
  is listed

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp import

```text
usage: wsp import <folder> [--to <workspace>] [--yes] [--keep, --cut <path>] [--agents <ids>] [--replace]
  lands a folder on the machine at its path here; the plan first, then --yes or
  one question; on this computer it registers the path and copies nothing;
  without --to, the workspace the last thread started on

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp export

```text
usage: wsp export <workspace> <folder> [--from <path on the machine>] [--replace] [--agents <ids>]
  brings a project folder and the agent sessions keyed to it home from the
  machine

  --json         print the raw protocol values, one JSON line each
  --state PATH   the state file the host serves
```

## wsp terminal

```text
wsp - your setup, on cloud machines, for coding agents

usage:
  wsp up             start the app and the runtime over the golden you sealed
                     (plain wsp does the same). It serves until you stop it, so
                     closing that terminal takes the app down with it; --service
                     hands the same line to this computer's own service manager
                     instead, which starts it now and again at every login
  wsp down           stop the service and take it away, so nothing brings the
                     host back at the next login
  wsp status         whether a host is serving this state file, on which ports,
                     and what keeps it there, with a non-zero exit code when
                     none does
  wsp init           set up your first golden image one screen at a time:
                     Agents, Tools, Also on this computer, Sign-ins, wsp for
                     your agents on this computer, each shown when it has a
                     row to pick, then Build, then the browser. With no
                     provider key it seals nothing and makes this computer
                     your workspace instead
  wsp doctor         run the reach loop end to end against one live machine
                     (--yes also deletes the snapshots this host left behind);
                     --local proves the other half instead, a thread on this
                     computer and its reply, with no machine and no key
  wsp mcp            serve the verbs as MCP tools over stdio to an agent on this
                     computer; wsp mcp install --agent <id> puts the server in
                     that agent's own MCP config (claude, codex, gemini, opencode),
                     the wsp skill in its skills folder, and wsp's own section
                     in this folder's AGENTS.md, which --remove takes back out.
                     --agent repeats and off a terminal every agent on your PATH
                     takes it; --json prints one line holding what each agent
                     took and a failures array for the ones that took nothing;
                     all three are read by mcp install alone
  wsp --version      print the version

verbs; every one takes --json for its raw values. The recipe verbs read this
computer and write beside the state file; the rest speak to the host wsp up
started:
  wsp workspaces
      every workspace this host runs: what its machine is, its state as the
      sidebar shows it (running, paused, waking or unreachable, off the phase
      with the provider's word for the machine and the daemon reach beside it)
      where the kind has one, and how many projects it holds
  wsp projects <workspace>
      the projects on the workspace, oldest import first: name, folder on the
      machine, size and when it landed; the name is what thread new --project
      takes
  wsp threads [--in <workspace>]
      every thread as the sidebar lists it: agent, state, who opened it, the
      folder it works in
  wsp threads wait <thread>... [--timeout <s>]
      blocks until one of the threads leaves running and prints its finished
      line, the one a notify sends; --timeout gives up after so many seconds and
      says so on stderr
  wsp recipe scan [--project <folder>]
      read this computer and print every option, writing nothing: the agents,
      the tools with why and size, what else a package manager here has that the
      image could take, the commands your agents ran, and the sign-ins, each
      with what to do about it and one line of why; --project weighs the
      histories by a folder and --json prints it as one object
  wsp recipe [--tick used|installed|default] [--set <id>=on|off]
    [--signin <id>=copy|machine|key|skip] [--add <id>=<command>]
    [--add-check <id>=<command>] [--project <folder>] [--out <path>]
      write the recipe and print it as a table: every catalog agent and tool
      with its tick, why it has it and what it costs on the machine, then the
      commands your agents ran that no catalog row carries. --tick
      used|installed|default names the rule that decides every tick (used, the
      default, ticks what your agents actually ran here); --set <id>=on|off
      flips a row by its catalog id, or a package this computer's own package
      managers have by the id wsp recipe scan gives it, which the build installs
      by that package's own road; --signin <id>=copy|machine|key|skip answers a
      sign-in by catalog id, key bringing the key files beside a login and
      nothing else of it; --add <id>=<command> carries a tool neither the
      catalog nor this computer has, installed by that command on the machine,
      with --add-check <id>=<command> saying it is there; --project reads a
      folder's own manifests for what it takes to build and weighs the histories
      by it, --out says where the file goes and --json prints the table as one
      object. Naming --tick or --project decides every tick again; without
      either, what the file says stands and the flags flip rows on top of it. A
      sign-in answer stands either way: no rule decides one. All of them repeat.
      Review it, then wsp init --recipe
  wsp new <name> [--from <project golden>] [--size <cpu>x<memGb>] | wsp new
    --local [name] | wsp new --ssh <user@host> [name] [--ssh-port <port>]
    [--ssh-key <path>]
      a workspace from the golden's head or, with --from, a project golden;
      --local is this computer, --ssh a machine of your own
  wsp rename <workspace> "<name>"
      names the workspace on this computer; the name is unique here, so one
      another workspace holds is refused
  wsp snapshot <workspace>
      a project golden of the workspace: its golden plus the project as it is
      now, ready to fork
  wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>]
    [--send "<task>" [thread new's flags]]
      a new machine from the source's golden version, not a copy of its live
      disk; --size as new's
  wsp pause <workspace>
      naps the workspace's machine
  wsp wake <workspace>
      wakes the workspace's machine and prints its state once the runtime has
      answered
  wsp rebuild <workspace>
      replaces a gone workspace's machine from its image and prints the state of
      the new one
  wsp image move <workspace>
      moves the workspace onto the newest version of its image and prints what
      of the image's own files it kept
  wsp forget <workspace> [--yes]
      drops a gone workspace and its threads from this computer; refused while
      its machine exists
  wsp delete <workspace> [--yes]
      deletes the machine at the provider, then drops the record and threads
      from this computer
  wsp thread new [--in <workspace>]
    [--agent, --model, --effort, --access, --project <name>, --cwd, --notify, -…
    "<task>"
      opens a thread with the agent, model, effort and access the app offers, in
      the project named or the one the app's pick would take; without --in, run
      from inside a registered repo, on the workspace that project last ran on;
      follows its first turn, or with --detach prints the id and returns
  wsp thread read <thread> [--last]
      the thread's messages as the app lists them, oldest first: who each one
      is, when the runtime recorded it and the text, with every tool call folded
      to the one line the app's row reads; --last prints the final reply alone,
      the whole message its finished line carries. A tool's output and the
      agent's reasoning are no rows of it
  wsp thread rename <thread> "<title>"
      names the thread inside the agent's own store, so the agent shows the same
      name
  wsp send <thread> [--model, --effort, --access <value>] [--image <path>]
    [--detach] "<message>"
      a message to the thread, on a named model, effort or access, with images;
      a running turn keeps its own; --detach prints the id and returns
  wsp stop <thread>
      stops the thread's running turn, as the app's stop does; the machine stays
      up
  wsp exec <workspace> [--cwd <dir>] -- <command...>
      runs the command on the machine, each word as given, in --cwd or the
      folder a thread would start in
  wsp folders [<folder>] [--hidden]
      the folders inside one folder on this computer, for naming one to import;
      the home folder and every imported project are the roots and nothing
      outside them is listed
  wsp import <folder> [--to <workspace>] [--yes] [--keep, --cut <path>]
    [--agents <ids>] [--replace]
      lands a folder on the machine at its path here; the plan first, then --yes
      or one question; on this computer it registers the path and copies
      nothing; without --to, the workspace the last thread started on
  wsp setup
      the cloud setup on this host as the app's Set up cloud machines modal
      reads it: which keys are held (never their values), the agents here, what
      a machine costs, and the init job's phase, rows and progress when one runs
      or ran
  wsp terminal config [--scheme light|dark]
      the Ghostty config on this computer as the app's terminal pane applies it,
      read from ~/.config/ghostty and Application Support with its includes and
      theme resolved: the font and its fallbacks, the size, the colors, the
      cursor, the padding, the background opacity, and the blur, which is read
      but not applied; --scheme picks the side of a light:...,dark:... theme
  wsp export <workspace> <folder> [--from <path on the machine>] [--replace]
    [--agents <ids>]
      brings a project folder and the agent sessions keyed to it home from the
      machine

  wsp send streams the reply to stderr as it arrives and prints the last message
  on stdout when the reply is complete.
  A turn ends when the agent process exits, not at its reply, and the thread
  reads running until then.
  wsp exec streams the command's output and exits with its code. thread new,
  send and exec wake a paused workspace first, with one line on stderr saying so.

exit codes; every failure is one line on stderr, the failure object with --json:
  0 ok        it did what its line says; with --json stdout holds the answer
  1 provider  the host, the runtime, Solari or the machine refused or failed
  2 auth      no key, no sign-in, or the host refused the token
  3 usage     the line was refused before anything ran: a missing argument, an
              unknown flag or a value nothing takes

options:
  --port N           app port (default 4400); the runtime websocket
                     port follows 10 above it
  --ws-port N        runtime websocket port on its own (default
                     4410); --port alone moves both
  --state PATH       state file: this word first, else WSP_HOME's state.json,
                     else ./.wsp/state.json when the current directory has a
                     .env, else state.json in the home the running host serves,
                     which is ~/.wsp unless current-home names another
  --yes              init: take every default and ask nothing (required off a
                     terminal); a login with a browser or device sign-in, or one
                     held in the Keychain, defaults to sign in on the machine
                     unless a saved recipe answered copy, so macOS has nothing
                     to ask either and the sign-ins wait for the app's terminal.
                     doctor: also delete the snapshots and templates this host
                     left behind, which is not reversible
  --recipe PATH      init: tick the agents and tools from this recipe (wsp recipe
                     writes it; init writes <state dir>/recipe.json too) and go
                     straight to the sign-ins; this machine is still read for
                     what travels
  --project PATH     init: the project folder you are bringing first. Its own
                     files (package.json, the lockfiles, pyproject, go.mod,
                     Cargo.toml, the compose files, .tool-versions, the CI
                     workflows) say what it needs, and those rows are ticked
                     first, each saying which file asked. Without it, init asks
                     for one before the first screen
  --first-workspace NAME
                     init: fork the first workspace under this name once the
                     golden seals, without asking (default first). A run with
                     nobody at a terminal forks nothing unless this or --import
                     asks for it
  --import FOLDER    init: import this folder's project onto that first
                     workspace, with the consent the app's import starts from:
                     caches left behind, secret-shaped files cut unless a
                     rewrite drops their credentials, and the sessions your
                     agents have for the folder travelling with it
  --no-local         init: leave this computer alone. The workspace step ticks
                     it by default, since a workspace here forks nothing and
                     bills nothing; this is the one way to end an init without
                     one. Refused on a run with no provider key, where it is
                     the only workspace there is
  --local            doctor: prove a thread on this computer and its reply
                     instead of the reach loop, which needs no provider key,
                     forks nothing and bills nothing
  --non-interactive  init: ask nothing, but still run the sign-ins on the
                     machine: each one prints the page to open on this computer,
                     the code when the flow shows one, and the command that
                     opens it, then waits for you (this is what a run off a
                     terminal does anyway). The run ends with the golden
                     recorded and never serves the app; wsp up does that
  --service          up: install the host as a launchd agent on a Mac, or a
                     systemd user unit on Linux, and wait for it to answer on
                     its port. The keys are not written into it: the service
                     reads the same .env a terminal run reads, so they have to
                     be in a file rather than exported in the shell that
                     installs it. It does pin the node and the wsp it was run
                     from by path, so a node that goes away later (an nvm
                     switch, a brew upgrade) stops the service at the next
                     login, with its log the only place that says why
  --json             init: print each build stage frame (with the install step
                     it belongs to, the command that step runs and its seconds
                     so far), each sign-in hand-off and its outcome as one JSON
                     object on stdout, then one last object naming the golden,
                     the recipe, the wsp up to run next and, unless
                     --first-workspace or --import asked for one, the wsp new
                     that forks a workspace; everything else on stderr. Implies
                     --non-interactive, and is refused beside --yes, which skips
                     the sign-ins

keys are read from the environment, then ./.env, then ~/.wsp/.env (WSP_HOME
overrides ~/.wsp). The prompt runs only when no Solari key is found; it asks
for the optional Anthropic key at the same time and can save both to that file.
With a Solari key present, a missing Anthropic key is only noted at start.
Without one, init and up take the local road: this computer is the workspace,
nothing is forked and nothing is sealed.
```

## wsp mcp

```text
usage: wsp mcp
       wsp mcp install --agent <id> [--agent <id>] [--json] [--remove]   (claude, codex, gemini, opencode)
```
