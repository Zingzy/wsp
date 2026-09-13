# Command line

Every verb, as `wsp --help` prints it. This page is generated from the binary at wsp 0.2.0; do not edit it by hand, run `pnpm --filter @wsp/docs cli` after the host changes.

Every verb takes `--json` for one JSON object per line, frames first and the result last, and `--state <path>` to name the state file the host serves. A refusal is one line on stderr and an exit code of its class: 0 ok, 1 provider, 2 auth, 3 usage. `wsp exec` exits with the command's own code.

```text
wsp - your setup, on cloud machines, for coding agents

usage: wsp <verb> ...

  wsp init                        seal this computer into your image, once
  wsp add                         a place: user@host for a computer over ssh,
                                  <provider> for a provider
  wsp places                      your places, the default marked
  wsp remove <place>              take a place out; the computer is left as
                                  wsp found it
  wsp new <name>                  a workspace from your image; --on <place>
                                  says where, once you have more than one
  wsp import <workspace> <folder> put a folder in it; again for the next one
  wsp run <workspace> "<task>"    an agent works in it and you read its reply
  wsp pause <workspace>           sleep it now; an idle one sleeps by itself
  wsp wake <workspace>            wake it now; run, send and exec wake it anyway
  wsp delete <workspace>          gone; the image stays
  wsp workspaces                  what you have, and where each one runs
  wsp threads [<workspace>]       who is working, and in which workspace
  wsp send <thread> "<message>"   the thread's next message
  wsp stop <thread>               end the thread's running turn
  wsp status                      whether a host serves, and where
  wsp mcp                         the verbs as tools for agents on this computer

A workspace or a thread comes right after the verb. new takes --on <place> once
you have more than one place; run and send take the agent's own flags, run
--help lists them. Sleeping is automatic.

wsp <verb> --help      the verb's own flags
wsp --help agent       the verbs your agents use, and up and down
wsp host --help        a host on another computer: pair, connect, link
wsp --version
```

## wsp --help agent

```text
the verbs your agents use, and the two lines that serve a host by hand:
  wsp projects <workspace>
      the projects on the workspace, oldest import first: name, folder on the
      machine, size and when it landed; the name is what wsp run --project takes
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
    [--signin <id>=copy|machine|later|key|skip] [--add <id>=<command>]
    [--add-check <id>=<command>] [--engine] [--project <folder>] [--out <path>]
      write the recipe and print it as a table: every catalog agent and tool
      with its tick, why it has it and what it costs on the machine, then the
      commands your agents ran that no catalog row carries. --tick
      used|installed|default names the rule that decides every tick (used, the
      default, ticks what your agents actually ran here); --set <id>=on|off
      flips a row by its catalog id, or a package this computer's own package
      managers have by the id wsp recipe scan gives it, which the build installs
      by that package's own road; --signin <id>=copy|machine|later|key|skip
      answers a sign-in by catalog id, later leaving it to the first time the
      tool is needed on the workspace and key bringing the key files beside a
      login and nothing else of it; --add <id>=<command> carries a tool neither
      the catalog nor this computer has, installed by that command on the
      machine, with --add-check <id>=<command> saying it is there; --engine
      marks the recipe so every workspace from its image gets the place's Docker
      or podman through a socket of its own (a project whose compose file needs
      one), and stays in the file until you edit it out; --project reads a
      folder's own manifests for what it takes to build and weighs the histories
      by it, --out says where the file goes and --json prints the table as one
      object. Naming --tick or --project decides every tick again; without
      either, what the file says stands and the flags flip rows on top of it. A
      sign-in answer stands either way: no rule decides one. All of them repeat.
      Review it, then wsp init --recipe
  wsp workspaces agents <workspace> --spawn on|off [--max-machines <n>]
    [--max-depth <n>]
      what the agents inside the workspace may ask of this host: off, or threads
      and machines under the thread they run in, capped
  wsp rename <workspace> "<name>"
      names the workspace on this computer; the name is unique here, so one
      another workspace holds is refused
  wsp snapshot <workspace>
      a project image of the workspace: your image plus the project as it is
      now, ready to fork
  wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>]
    [--send "<task>" [run's flags]]
      a new machine from the source's image version, not a copy of its live
      disk; --size as new's
  wsp image
      the image this host owns: its version, its hash, whether it holds your
      sign-ins, and the copy each place has built of it
  wsp image build <place> [--force]
      builds this host's image at a place from the record, its sign-ins coming
      from the vault and no sign-in run again
  wsp image export <file>
      writes the image record and your sign-ins to one encrypted file, sealed to
      a passphrase you type
  wsp forget <workspace> [--yes]
      drops a gone workspace and its threads from this computer; refused while
      its machine exists
  wsp thread read <thread> [--last]
      the thread's messages as the app lists them, oldest first: who each one
      is, when the runtime recorded it and the text, with every tool call folded
      to the one line the app's row reads; --last prints the final reply alone,
      the whole message its finished line carries. A tool's output and the
      agent's reasoning are no rows of it
  wsp thread forget <thread>
      drops a thread no turn ever ran on, the row a launch that never got going
      leaves behind; refused once a turn of it did work
  wsp thread allow <thread>
      answers the prompt the thread is stopped on and lets the call run
  wsp thread deny <thread>
      answers the prompt the thread is stopped on and refuses the call
  wsp exec <workspace> [--cwd <dir>] -- <command...>
      runs the command on the machine, each word as given, in --cwd or the
      folder a thread would start in
  wsp export <workspace> <folder> [--from <path on the machine>] [--replace]
    [--agents <ids>]
      brings a project folder and the agent sessions keyed to it home from the
      machine
  wsp mcp install --agent <id> [--agent <id>] [--host <alias>] [--json]
    [--remove]   (claude, codex, gemini, opencode)
      put the wsp tools, this skill and wsp's own section of this folder's
      AGENTS.md into that agent (claude, codex, gemini, opencode); --agent
      repeats, --remove takes it back out, and --json prints what each agent
      took
  wsp up [--port <n>] [--ws-port <n>] [--listen <addr>] [--advertise <url>]
    [--provider <name>] [--docker-host <url>] [--no-relay] [--service]
      serve the host in this terminal, for a host you want to watch or one that
      serves beyond this computer; --service hands the same line to this
      computer's own service manager, which starts it now and again at every
      login. Every other line starts a host for itself when none serves
  wsp down
      stop the host: the service and its unit where one holds it up, and the
      host a verb started otherwise
  wsp join <url>... --code <code> [--code-file <path>] [--name <name>] [--awake]
      on the computer you are sitting at: join it to the wsp at that address,
      then install the daemon under this computer's own service manager, which
      dials again at every login
  wsp leave
      on that computer: take wsp off it, for a computer whose host is gone and
      cannot run wsp remove

  wsp send streams the reply to stderr as it arrives and prints the last message
  on stdout when the reply is complete.
  A turn ends when the agent process exits, not at its reply, and the thread
  reads running until then.
  wsp exec streams the command's output and exits with its code. run, send and
  exec wake a paused workspace first, with one line on stderr saying so.

every verb takes:
  --json         print the raw protocol values, one JSON object per line, with
                 everything else on stderr
  --state        the state file the host serves
  --host         run the line against a host on another computer, by the name
                 wsp host connect gave it; WSP_HOST names one for a whole shell

exit codes; every failure is one line on stderr, the failure object with --json:
  0 ok        it did what its line says; with --json stdout holds the answer
  1 provider  the host, the runtime, Solari or the machine refused or failed
  2 auth      no key, no sign-in, or the host refused the token
  3 usage     the line was refused before anything ran: a missing argument, an
              unknown flag or a value nothing takes
```

## wsp host --help

```text
  wsp host pair
      a one time code another computer redeems for a token of its own, when the
      host listens beyond this computer
  wsp host devices [revoke <id>]
      the computers paired with this host; revoke takes one back out
  wsp host connect <url> --code <code> [--name <alias>] [--relay <host>]
      redeem a code from a host on another computer for a token of this one's
      own; --name is what every later line calls that host, and --relay reaches
      it through your relay by the name it has there
  wsp host list
      the hosts on other computers this computer holds, the default marked
  wsp host default <alias>
      move which host every line on this computer runs against
  wsp host forget <alias>
      hand that host its token back and forget it here
  wsp host link <url> [--name <name>]
      put this computer on your relay account, so it is reachable from anywhere
      with no port open to the world; it prints a code and a page to approve it
      on
  wsp host unlink
      take this computer off the relay account and stop its tunnel
  wsp host linked [<url>]
      the boxes on your relay account, from whichever computer you are at
  wsp host clients [revoke <id>]
      which computers hold a token for your relay account; revoke signs one out
  wsp host devices revoke <id>
      take one computer's token away
  wsp host clients revoke <id>
      sign one computer out of your relay account

You need these only for a host serving on a computer that is not the one you are
sitting at, or for one outside your own account: pair and devices hand out and
take back the codes that let another computer drive a host, and they run at that
host's own terminal; connect, list, default and forget hold the hosts this
computer drives; link, unlink, linked and clients put a computer on your relay,
so it is reachable with no port open to the world.
```

## wsp --help dev

```text
  wsp doctor [--local] [--yes]
      prove one workspace end to end: your image, a machine forked from it, wsp
      on that machine, a file coming back and the teardown; --local proves the
      other half instead, a thread on this computer and its reply, with no
      machine and no key
```

## wsp init

```text
usage: wsp init [--on <place>] [--recipe <path>] [--project <path>]
       [--first-workspace <name>] [--import <folder>] [--rebuild] [--no-local]
       [--yes] [--non-interactive] [--json]
  seal this computer into your image, one screen at a time: Agents, Tools, Also
  on this computer, Sign-ins, wsp for your agents on this computer, each shown
  when it has a row to pick, then Build. Beside a host already serving this
  state file the screens are the same and the build runs in that host, on the
  place --on names or its default place, a computer you joined included. With no
  host serving and no provider key it seals nothing and makes this computer your
  workspace instead

  --state              the state file: this word first, else WSP_HOME's
                       state.json, else ./.wsp/state.json when the current
                       directory is a checkout of wsp, else state.json in the
                       home the running host serves
  --provider           which machine provider this computer forks on; without
                       it, a key saved under a provider's own variable wires
                       that provider
  --docker-host        the Docker daemon to dial, as DOCKER_HOST words it; this
                       computer's own socket without it
  --yes                take every default and ask nothing, which a run off a
                       terminal needs; a login with a browser or device sign-in,
                       or one held in the Keychain, is left to the first time
                       you need it on the workspace unless a saved recipe
                       answered copy, so macOS has nothing to ask either and the
                       build waits on nobody
  --recipe             tick the agents and tools from this recipe (wsp recipe
                       writes it) and go straight to the sign-ins
  --project            the project folder you are bringing first; its own files
                       say what it needs, and those rows are ticked first
  --on                 the place the image is built on, by the name wsp places
                       lists, a computer you joined included; the default place
                       without it
  --first-workspace    fork the first workspace under this name once the image
                       seals, without asking (default first)
  --import             import this folder's project onto that first workspace,
                       with the consent the app's import starts from
  --rebuild            seal the next version from a fresh machine rather than
                       from your image plus the changes, which is the question a
                       run at a terminal is asked; without it a run that asks
                       nothing takes whichever road the changes call for
  --no-local           leave this computer alone; the workspace step ticks it by
                       default, since a workspace here forks nothing and bills
                       nothing
  --non-interactive    ask nothing, but still run the sign-ins on the machine:
                       each prints the page to open on this computer, the code
                       when the flow shows one, and the command that opens it,
                       then waits for you
  --json               print the raw protocol values, one JSON object per line,
                       with everything else on stderr
```

## wsp add

```text
usage: wsp add [<provider>|user@host] [--name <name>] [--ssh-port <port>]
       [--ssh-key <path>]
  a place: user@host for a computer over ssh, <provider> for a provider, nothing
  for the join line another computer types

  --state       the state file: this word first, else WSP_HOME's state.json,
                else ./.wsp/state.json when the current directory is a checkout
                of wsp, else state.json in the home the running host serves
  --name        the name to call the computer by here; what its address calls it
                without one
  --ssh-port    the port ssh dials that computer on (default 22)
  --ssh-key     the key file ssh logs in with; whatever your own ssh config and
                agent already use without it
  --host        read to say this line runs at its own host's terminal; it dials
                no other
```

## wsp places

```text
usage: wsp places
  every place this host holds: this computer, the computers joined to it and the
  provider it forks on, with what each has and whether it is connected

  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp remove

```text
usage: wsp remove <place>
  take a place out; the agent, its files and the workspaces standing on it go,
  and the computer is left as wsp found it

  --state    the state file: this word first, else WSP_HOME's state.json, else
             ./.wsp/state.json when the current directory is a checkout of wsp,
             else state.json in the home the running host serves
  --host     read to say this line runs at its own host's terminal; it dials no
             other
```

## wsp new

```text
usage: wsp new <name> [--on <place>] [--from <project image>]
       [--size <cpu>x<memGb>] [--engine] [--spawn on|off] [--max-machines <n>]
       [--max-depth <n>]
  a workspace from your image; --on <place> says where, and you meet it only
  once you have more than one place; --engine gives it the place's Docker or
  podman through a socket that sees its own containers alone

  --from            a project image to start from, by its project's name or its
                    snapshot id, as wsp snapshot returns them
  --size            the machine size as <cpu>x<memGb>, like 2x4; a size the
                    provider does not offer is refused naming the ones it does
  --on              the place it lands on, by the name wsp places lists; where
                    the last one landed without it
  --engine          give it the place's Docker or podman through a socket that
                    sees its own containers alone
  --spawn           on lets the agents there open threads and fork machines of
                    their own, capped; off is what a workspace made without it
                    is
  --max-machines    how many machines may stand at once under one root thread;
                    needs --spawn on, and defaults to 3
  --max-depth       how many levels of threads may stand under the root thread;
                    needs --spawn on, and defaults to 1
  --json            print the raw protocol values, one JSON object per line,
                    with everything else on stderr
  --state           the state file the host serves
  --host            run the line against a host on another computer, by the name
                    wsp host connect gave it; WSP_HOST names one for a whole
                    shell
```

## wsp import

```text
usage: wsp import [<workspace>] <folder> [--yes] [--keep, --cut <path>]
       [--agents <ids>] [--replace]
  puts a folder in the workspace, at its path here; the plan first, then --yes
  or one question; on this computer it registers the path and copies nothing;
  with no workspace, the one the last thread started on

  --yes        take the plan's own answer for every row instead of being asked
  --keep       a path inside the folder to carry to the machine, on top of the
               plan's own answer; repeats
  --cut        a path inside the folder to leave behind, on top of the plan's
               own answer; repeats
  --agents     the agents whose sessions for that folder travel with it, by
               catalog id, comma separated; every one that has them without it
  --replace    overwrite what is already at the destination
  --json       print the raw protocol values, one JSON object per line, with
               everything else on stderr
  --state      the state file the host serves
  --host       run the line against a host on another computer, by the name wsp
               host connect gave it; WSP_HOST names one for a whole shell
```

## wsp run

```text
usage: wsp run [<workspace>] [--agent <id>] [--model, --effort, --access <word>]
       [--project <name>] [--cwd <path>] [--notify <thread|me>]
       [--title <title>] [--image <path>] [--detach] "<task>"
  an agent works in the workspace and you read its reply: a thread with the
  agent, model, effort and access the app offers, in the project named or the
  one the app's pick would take; with no workspace, run from inside a registered
  repo, on the workspace that project last ran on; follows its first turn, or
  with --detach prints the id and returns

  --agent      which agent runs the thread, by its catalog id (claude, codex);
               the workspace's own default without it
  --model      the model the turn runs on, by the agent's own slug
               (claude-sonnet-5); the thread's own without it
  --effort     how hard the agent thinks, by its own word (low, medium, high,
               xhigh, max); its default without it
  --access     how far the agent may go without asking, by the agent's own word
               (plan, acceptEdits, bypassPermissions); its default without it
  --project    the project inside the workspace to work in, by name; the one the
               last thread there used without it
  --cwd        the folder on the machine to work in; the project's folder
               without it
  --notify     where each turn's end is sent, a thread's id or me; repeats
  --title      what to call the thread; the agent names it from the task without
               one
  --image      an image file on this computer to send with the message; repeats
  --detach     print the thread's id and return, leaving the reply to the
               thread's finished line
  --json       print the raw protocol values, one JSON object per line, with
               everything else on stderr
  --state      the state file the host serves
  --host       run the line against a host on another computer, by the name wsp
               host connect gave it; WSP_HOST names one for a whole shell
```

## wsp pause

```text
usage: wsp pause <workspace>
  naps the workspace's machine

  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp wake

```text
usage: wsp wake <workspace>
  wakes the workspace's machine and prints the state the next wsp workspaces
  will show for it

  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp delete

```text
usage: wsp delete <workspace> [--yes]
  deletes the machine at the provider, then drops the record and threads from
  this computer

  --yes      go ahead without being asked
  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp workspaces

```text
usage: wsp workspaces [--watch]
  every workspace this host runs: the computer or provider it runs on, the shape
  of its machine, its state as the sidebar shows it (running, paused, waking or
  unreachable, off the phase with the provider's word for the machine and the
  daemon reach beside it), and how many projects it holds; --watch draws the
  same table again every second where it stands

  --watch    draw the table again every second where it stands, until Ctrl-C; it
             needs a terminal to redraw on
  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp threads

```text
usage: wsp threads [<workspace>] [--tree] [--watch]
  who is working, and in which workspace: every thread as the sidebar lists it,
  with the agent, the state, who opened it and the folder it works in; --tree
  indents the threads an agent spawned under the one that spawned them, and
  --watch draws the same table again every second where it stands

  --tree     indent the threads an agent opened under the one that opened them
  --watch    draw the table again every second where it stands, until Ctrl-C; it
             needs a terminal to redraw on
  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp send

```text
usage: wsp send <thread> [--model, --effort, --access <value>] [--image <path>]
       [--detach] "<message>"
  a message to the thread, on a named model, effort or access, with images; a
  running turn keeps its own; --detach prints the id and returns

  --model     the model the turn runs on, by the agent's own slug
              (claude-sonnet-5); the thread's own without it
  --effort    how hard the agent thinks, by its own word (low, medium, high,
              xhigh, max); its default without it
  --access    how far the agent may go without asking, by the agent's own word
              (plan, acceptEdits, bypassPermissions); its default without it
  --image     an image file on this computer to send with the message; repeats
  --detach    print the thread's id and return, leaving the reply to the
              thread's finished line
  --json      print the raw protocol values, one JSON object per line, with
              everything else on stderr
  --state     the state file the host serves
  --host      run the line against a host on another computer, by the name wsp
              host connect gave it; WSP_HOST names one for a whole shell
```

## wsp stop

```text
usage: wsp stop <thread>
  stops the thread's running turn, as the app's stop does; the machine stays up

  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp status

```text
usage: wsp status [--watch]
  whether a host serves this state file, on which ports and what keeps it there,
  with a non-zero exit code when none does; on a computer joined to somebody's
  wsp it reads the agent there instead, what that computer is doing and what is
  running on it, and --watch draws the same rows again every second. --host
  reads a host on another computer

  --state    the state file: this word first, else WSP_HOME's state.json, else
             ./.wsp/state.json when the current directory is a checkout of wsp,
             else state.json in the home the running host serves
  --watch    draw the same rows again every second where they stand, until
             Ctrl-C; it needs a terminal to redraw on, and reads nothing but
             this computer's own agent
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp mcp

```text
usage: wsp mcp [--host <alias>]
       wsp mcp install --agent <id>
       [--agent <id>] [--host <alias>] [--json] [--remove]   (claude, codex,
       gemini, opencode)
  serve the verbs as tools over stdio to an agent on this computer

  --state    the state file the host serves
  --host     write the server against a host on another computer, by the name
             wsp host connect gave it, so the tools drive that host
```

## wsp up

```text
usage: wsp up [--port <n>] [--ws-port <n>] [--listen <addr>] [--advertise <url>]
       [--provider <name>] [--docker-host <url>] [--no-relay] [--service]
  serve the host in this terminal, for a host you want to watch or one that
  serves beyond this computer; --service hands the same line to this computer's
  own service manager, which starts it now and again at every login. Every other
  line starts a host for itself when none serves

  --state          the state file: this word first, else WSP_HOME's state.json,
                   else ./.wsp/state.json when the current directory is a
                   checkout of wsp, else state.json in the home the running host
                   serves
  --port           the app port (default 4400); the runtime websocket port
                   follows 10 above it
  --ws-port        the runtime websocket port on its own (default 4410); --port
                   alone moves both
  --listen         the address to bind (default 127.0.0.1, this computer alone).
                   On any other address the page is served without the host
                   token and every client pairs for a device token of its own
  --advertise      the address every machine dials this host at, whatever kind
                   it is; each kind answers for its own machines without it
  --no-relay       serve without the tunnel, on a computer that is linked to a
                   relay
  --service        install the host as a launchd agent on a Mac or a systemd
                   user unit on Linux, which serves now and again at every
                   login. The keys are not written into it: it reads the same
                   .env a terminal run reads, so they have to be in a file
  --provider       which machine provider this computer forks on; without it, a
                   key saved under a provider's own variable wires that provider
  --docker-host    the Docker daemon to dial, as DOCKER_HOST words it; this
                   computer's own socket without it
```

## wsp down

```text
usage: wsp down
  stop the host: the service and its unit where one holds it up, and the host a
  verb started otherwise

  --state    the state file: this word first, else WSP_HOME's state.json, else
             ./.wsp/state.json when the current directory is a checkout of wsp,
             else state.json in the home the running host serves
```

## wsp recipe

```text
usage: wsp recipe [--tick used|installed|default] [--set <id>=on|off]
       [--signin <id>=copy|machine|later|key|skip] [--add <id>=<command>]
       [--add-check <id>=<command>] [--engine] [--project <folder>]
       [--out <path>]
  write the recipe and print it as a table: every catalog agent and tool with
  its tick, why it has it and what it costs on the machine, then the commands
  your agents ran that no catalog row carries. --tick used|installed|default
  names the rule that decides every tick (used, the default, ticks what your
  agents actually ran here); --set <id>=on|off flips a row by its catalog id, or
  a package this computer's own package managers have by the id wsp recipe scan
  gives it, which the build installs by that package's own road; --signin
  <id>=copy|machine|later|key|skip answers a sign-in by catalog id, later
  leaving it to the first time the tool is needed on the workspace and key
  bringing the key files beside a login and nothing else of it; --add
  <id>=<command> carries a tool neither the catalog nor this computer has,
  installed by that command on the machine, with --add-check <id>=<command>
  saying it is there; --engine marks the recipe so every workspace from its
  image gets the place's Docker or podman through a socket of its own (a project
  whose compose file needs one), and stays in the file until you edit it out;
  --project reads a folder's own manifests for what it takes to build and weighs
  the histories by it, --out says where the file goes and --json prints the
  table as one object. Naming --tick or --project decides every tick again;
  without either, what the file says stands and the flags flip rows on top of
  it. A sign-in answer stands either way: no rule decides one. All of them
  repeat. Review it, then wsp init --recipe

  --out          where the recipe file is written
  --tick         the rule that decides every tick: used, installed, default
  --set          <id>=on|off flipping one row of the recipe by its id; repeats
  --signin       <id>=copy|machine|later|key|skip answering one sign-in by
                 catalog id; repeats
  --add          <id>=<command> carrying a tool neither the catalog nor this
                 computer has, installed by that command on the machine; repeats
  --add-check    <id>=<command> proving that added tool is on the machine;
                 repeats
  --engine       mark the recipe so every workspace from its image gets the
                 place's Docker or podman; it stays in the file until you edit
                 it out
  --project      a folder on this computer to weigh the histories by; repeats
  --json         print the raw protocol values, one JSON object per line, with
                 everything else on stderr
  --state        the state file the host serves
  --host         run the line against a host on another computer, by the name
                 wsp host connect gave it; WSP_HOST names one for a whole shell
```

## wsp fork

```text
usage: wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>]
       [--send "<task>" [run's flags]]
  a new machine from the source's image version, not a copy of its live disk;
  --size as new's

  --name            what to call the new workspace; <source>-fork without it
  --size            the machine size as <cpu>x<memGb>, like 2x4; a size the
                    provider does not offer is refused naming the ones it does
  --send            a task for the new workspace's first thread, with run's own
                    flags after it
  --agent           which agent runs the thread, by its catalog id (claude,
                    codex); the workspace's own default without it
  --model           the model the turn runs on, by the agent's own slug
                    (claude-sonnet-5); the thread's own without it
  --effort          how hard the agent thinks, by its own word (low, medium,
                    high, xhigh, max); its default without it
  --access          how far the agent may go without asking, by the agent's own
                    word (plan, acceptEdits, bypassPermissions); its default
                    without it
  --cwd             the folder on the machine to work in; the project's folder
                    without it
  --notify          where each turn's end is sent, a thread's id or me; repeats
  --spawn           on lets the agents there open threads and fork machines of
                    their own, capped; off is what a workspace made without it
                    is
  --max-machines    how many machines may stand at once under one root thread;
                    needs --spawn on, and defaults to 3
  --max-depth       how many levels of threads may stand under the root thread;
                    needs --spawn on, and defaults to 1
  --json            print the raw protocol values, one JSON object per line,
                    with everything else on stderr
  --state           the state file the host serves
  --host            run the line against a host on another computer, by the name
                    wsp host connect gave it; WSP_HOST names one for a whole
                    shell
```

## wsp snapshot

```text
usage: wsp snapshot <workspace>
  a project image of the workspace: your image plus the project as it is now,
  ready to fork

  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp rename

```text
usage: wsp rename <workspace> "<name>"
  names the workspace on this computer; the name is unique here, so one another
  workspace holds is refused

  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp forget

```text
usage: wsp forget <workspace> [--yes]
  drops a gone workspace and its threads from this computer; refused while its
  machine exists

  --yes      go ahead without being asked
  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp thread read

```text
usage: wsp thread read <thread> [--last]
  the thread's messages as the app lists them, oldest first: who each one is,
  when the runtime recorded it and the text, with every tool call folded to the
  one line the app's row reads; --last prints the final reply alone, the whole
  message its finished line carries. A tool's output and the agent's reasoning
  are no rows of it

  --last     the final reply alone, the whole message the thread's finished line
             carries
  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp exec

```text
usage: wsp exec <workspace> [--cwd <dir>] -- <command...>
  runs the command on the machine, each word as given, in --cwd or the folder a
  thread would start in

  --cwd      the folder on the machine to work in; the project's folder without
             it
  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp folders

```text
usage: wsp folders [<folder>] [--hidden]
  the folders inside one folder on this computer, for naming one to import; the
  home folder and every imported project are the roots and nothing outside them
  is listed

  --hidden    list the folders whose names start with a dot too
  --json      print the raw protocol values, one JSON object per line, with
              everything else on stderr
  --state     the state file the host serves
  --host      run the line against a host on another computer, by the name wsp
              host connect gave it; WSP_HOST names one for a whole shell
```

## wsp export

```text
usage: wsp export <workspace> <folder> [--from <path on the machine>]
       [--replace] [--agents <ids>]
  brings a project folder and the agent sessions keyed to it home from the
  machine

  --from       the folder on the machine to bring home; the project registered
               for the folder you named without it
  --replace    overwrite what is already at the destination
  --agents     the agents whose sessions for that folder travel with it, by
               catalog id, comma separated; every one that has them without it
  --json       print the raw protocol values, one JSON object per line, with
               everything else on stderr
  --state      the state file the host serves
  --host       run the line against a host on another computer, by the name wsp
               host connect gave it; WSP_HOST names one for a whole shell
```

## wsp image

```text
usage: wsp image
  the image this host owns: its version, its hash, whether it holds your
  sign-ins, and the copy each place has built of it

  --json     print the raw protocol values, one JSON object per line, with
             everything else on stderr
  --state    the state file the host serves
  --host     run the line against a host on another computer, by the name wsp
             host connect gave it; WSP_HOST names one for a whole shell
```

## wsp join

```text
usage: wsp join <url>... --code <code> [--code-file <path>] [--name <name>]
       [--awake]
  on the computer you are sitting at: join it to the wsp at that address, then
  install the daemon under this computer's own service manager, which dials
  again at every login

  --state        the state file: this word first, else WSP_HOME's state.json,
                 else ./.wsp/state.json when the current directory is a checkout
                 of wsp, else state.json in the home the running host serves
  --code         the code the other computer printed: wsp host pair for a host,
                 wsp add for a place
  --code-file    read the code off this file and delete the file before dialing,
                 so a code never sits on a disk
  --awake        hold this computer out of idle sleep while it is joined, for as
                 long as the agent runs
  --name         the name to call the computer by here; what its address calls
                 it without one
```

## wsp leave

```text
usage: wsp leave
  on that computer: take wsp off it, for a computer whose host is gone and
  cannot run wsp remove

  --state    the state file: this word first, else WSP_HOME's state.json, else
             ./.wsp/state.json when the current directory is a checkout of wsp,
             else state.json in the home the running host serves
```

## wsp doctor

```text
usage: wsp doctor [--local] [--yes]
  prove one workspace end to end: your image, a machine forked from it, wsp on
  that machine, a file coming back and the teardown; --local proves the other
  half instead, a thread on this computer and its reply, with no machine and no
  key

  --state    the state file: this word first, else WSP_HOME's state.json, else
             ./.wsp/state.json when the current directory is a checkout of wsp,
             else state.json in the home the running host serves
  --yes      also delete the snapshots and templates this host left behind,
             which is not reversible
  --local    prove a thread on this computer and its reply instead of a forked
             machine, which needs no provider key, forks nothing and bills
             nothing
```
