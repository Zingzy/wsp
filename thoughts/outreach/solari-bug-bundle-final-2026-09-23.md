# The first week on the sandbox API: what broke, what we did about it, what we would change

Hi,

We are wsp. We build one Linux machine per developer on Solari, snapshot it as a golden, and fork a fresh workspace from that golden for every task an agent or a person works on. We have been building against api.getsolari.com every day since 2026-09-01 on a Starter account. Everything below was measured between 2026-09-01 and 2026-09-07 and carries its UTC time. Your 2026-09-10 update moved Solari onto new infrastructure, and your 2026-09-21 update fixed several compute faults, so some of this may already be fixed. If you tell us which, we will re-run our probes and delete the workarounds. Most of it works, and the parts that work are the reason we picked you: forks come up as live clones with RAM and running processes intact, and pause and resume keep a process mid-stream.

This note is the other part. Below are eight things we hit, in the order they cost us. Each one says what we called, what came back, what we expected, how often, what we built around it, and the smallest change on your side that would let us delete that code. After the bugs there is a list of API facts we inferred and would like confirmed, and four asks.

We would like a fix or a plan on the first three bugs, a conversation about the plan above Starter, and a person we can send request timestamps to when something like this happens again.

---

## 1. Snapshot answers 502 and the running sandbox is then gone

**Called.** `POST /sandboxes/<sandbox-id>/snapshots` with body `{"name": "golden-v1"}`, on a sandbox we had created 28 minutes earlier and that `GET /sandboxes/<sandbox-id>` had read as `running` throughout (wsp-map#358).

**Came back.** HTTP 502 after 17 s. The body's error text was `Failed to snapshot sandbox`, with no code field. The next `GET /sandboxes/<sandbox-id>` answered 404. The sandbox was absent from `GET /sandboxes`, and `GET /snapshots` had no new row. 2026-09-07 01:19 UTC (wsp-map#358).

**Expected.** Either a snapshot id, or a refusal that leaves the running machine where it was. A refused snapshot should never end the machine it refused.

**How often.** Once in this form, on a person's first golden build, so it cost the whole build. An earlier form on 2026-09-01: a sandbox that had been idle-paused overnight and resumed answered the same bare 502 to three snapshot attempts in a row starting 01:28 UTC, while fresh sandboxes and short pause-resume sandboxes snapshotted fine (wsp-map#4). Same message both times. The 2026-09-07 sandbox had never been paused by us, but its `createdAt` had moved from 00:51:14 to 01:04:02 while it ran, and an npm download inside it stalled dead at about that minute (wsp-map#355, wsp-map#358). Inferred: the machine was rebooted or moved at 01:04 and could not be snapshotted afterwards.

**Cost to us.** 28 minutes of tool installs and sign-ins, redone by hand. We then shipped a retry: up to three snapshot attempts a minute apart while the GET still reads `running`, and the builder is kept and re-attachable when the provider still has it (wsp-map#358). That adds up to two minutes to a failing seal, and it does nothing when the machine is already gone.

**Smallest change.** A code on that 502 (a permanent `SnapshotUnavailable` versus a transient one), and the machine left running after a refused snapshot. If a relocated machine cannot be snapshotted, say so in the body and we will rebuild before we ask. Your 2026-09-22 note added a permanent `SnapshotNotRestorable` code for a snapshot that cannot be restored, which is the shape we want. The snapshot-taking 502 here still carries no code.

## 2. Pause on a running sandbox answers 409, and six seconds later the sandbox is 404

**Called.** `POST /sandboxes/<sandbox-id>/pause` with body `{}` on a sandbox whose `GET /sandboxes/<sandbox-id>` read `running` with an `expiresAt` that had rolled forward on each of the previous three polls (01:56:58, 01:58:27, 01:58:32) (wsp-map#277).

**Came back.** HTTP 409. Six seconds later `GET /sandboxes/<sandbox-id>` answered 404 `Not found` and the sandbox was absent from `GET /sandboxes`. 2026-09-07 01:21 UTC (wsp-map#277). In the two earlier instances the 409 body's error text was `Not pausable` (wsp-map#277).

**Expected.** Pause a running machine, or refuse with a reason and keep it running. A machine that cannot be paused should not be removed.

**How often.** Four running sandboxes in 16 hours, none of them touched by a delete from us:

| when (UTC) | what we saw | ticket |
|---|---|---|
| 2026-09-06 between 09:55 and 10:21 | idle pause refused `Not pausable`, sandbox gone by 10:21 | wsp-map#277 |
| 2026-09-06 17:58 to 18:04 | `wsp pause` got `Not pausable`, retry got `Not found`; two agent sessions were mid-turn with unpushed work | wsp-map#277 |
| 2026-09-07 01:19 | the snapshot 502 in bug 1, same two minutes | wsp-map#358 |
| 2026-09-07 01:21 | 409 on pause, 404 six seconds later, watched directly | wsp-map#277 |

In every case the paused sandboxes on the account survived and only running ones vanished (wsp-map#277, wsp-map#358).

**Inferred, not proven.** Your API reference gives a 409 on pause one meaning: "Not pausable. The host no longer knows this VM." So by the time we asked, the host had already lost the machine while the gateway still read `running`. The same reference says `GET /sandboxes/:id` reads a paused record through from durable storage on a gateway-restart cache miss, "so a paused VM survives a redeploy", and that the gateway's snapshot store is otherwise in-memory. It also describes two reapers, the gateway deadline as the authoritative one and the host's own TTL reaper as a best-effort backstop. Both fit what we saw. Running machines vanished in clusters at 2026-09-06 09:55 to 10:21, 2026-09-06 17:58 to 18:04 and 2026-09-07 01:04 to 01:21 UTC, and every paused machine on the account came through each time. Did you deploy or restart the gateway in those windows, or did a host reaper fire while the gateway still showed the machines running? For the record, a running machine's `expiresAt` sits about 40 minutes ahead and rolls forward while we talk to it (23:15:04, then 23:16:35 ninety seconds later), and a paused one keeps a stale `expiresAt` in the past and does not expire (wsp-map#277). Whichever it was, the disk was thrown away for machines that were doing work. Your 2026-09-10 move to redundant, multi-zone infrastructure and your 2026-09-21 note that a warm standby now answers while another instance restarts both speak to this window. Tell us whether it is closed and we will stop watching for it.

**Cost to us.** Lost work on two workspaces. We shipped a reconcile sweep that reads every recorded machine at the provider and moves a 404 to a `gone` state with rate 0 (wsp-map#277, wsp-map#250), a files vault exported at every pause so a lost machine costs processes and not files (wsp-map#54), and a plan to log `expiresAt` on every poll and warn when it is under ten minutes (wsp-map#277).

**Smallest change.** Do not remove a running sandbox when the host loses it or the gateway restarts; pause it, or at least snapshot its disk before release, and put a `state` and a reason on the record (`releasing` with `reason: host lost` or `reason: lease expired`) for long enough that a poller sees it. We never saw a `gone` or `releasing` state on any machine; every removal was a 404 (wsp-map#4, 2026-09-04).

## 3. Resume hangs forever after a pause taken while the guest was out of memory

**Called.** `POST /sandboxes/<sandbox-id>/pause` with `{}` on a 2 vCPU, 4 GB sandbox whose guest had 3.8 of 3.9 GB used and load 6. The pause took several minutes and completed. Then `POST /sandboxes/<sandbox-id>/resume` with `{}` (wsp-map#4).

**Came back.** Nothing. curl gave up after 120 s with HTTP 000. A second attempt with a 300 s limit also got no reply. `GET /sandboxes/<sandbox-id>` kept answering `state: paused` and the listing agreed. Your own console's resume for the same machine (`console.getsolari.com/api/desktops/<sandbox-id>/resume`) answered 504 Gateway Time-out. 2026-09-06 13:02 to 13:15 UTC (wsp-map#4).

**Expected.** A resume that either brings the machine back or fails with a status and a code. A paused machine that can never be resumed and never times out is a stuck record.

**How often.** Once. The machine is still paused at the provider as far as we know.

**Cost to us.** The workspace was written off and forked fresh from its golden (wsp-map#4). We also shipped guest-side memory protection so our own daemon survives a memory squeeze (wsp-map#300), which is unrelated to your side but is why we were pausing an out-of-memory guest in the first place.

**Smallest change.** Bound the resume call and answer with a code when the RAM image cannot be restored. If a pause of a guest in that state is known to produce an unrestorable image, refuse the pause with a code instead.

## 4. Resume says running while the guest serves nothing for ten minutes or more

**Called.** `POST /sandboxes/<sandbox-id>/resume` with `{}`, then `GET /sandboxes/<sandbox-id>`, then `POST /sandboxes/<sandbox-id>/exec` with `{"cmd": "bash", "args": ["-c", "..."], "timeoutMs": ...}`, and a GET through the preview URL to a port the guest was serving before the pause (wsp-map#4, wsp-map#54).

**Came back.** `GET` said `state: running`. Every exec answered 502 `transient` after 8 to 36 s, and the preview edge answered 502 after 5 to 11 s, for over ten minutes. A fresh sandbox created on the same account at the same moment answered exec in 759 ms. 2026-09-02 about 18:50 UTC onward (wsp-map#4). A second instance on 2026-09-03 about 09:45 UTC on a machine we had not woken: it sat overnight, read `running`, and exec took 38 s to fail with 502 while a fresh sandbox answered in 668 ms (wsp-map#4, wsp-map#85). Inferred: a provider-side idle pause and resume, or a host move, on the second one.

**Expected.** `running` to mean the guest can run a command. Until then, `starting`.

**How often.** Two zombies in 12 hours on two machines, 2026-09-02 and 2026-09-03 (wsp-map#4). Not seen since, but we now check for it on every wake.

**Cost to us.** A wake is not done for us until our own process inside the guest answers through the preview edge, bounded at 30 s. If it never does we pause and resume once more, and if that fails we fork a replacement from the golden, import the pause-time files vault, and kill the zombie (wsp-map#54). A watcher does the same for machines that go bad at rest (wsp-map#85).

**Smallest change.** Report `starting` until the guest agent has answered once after resume, and `running` only after. That would let us delete the pause-and-resume retry and the zombie watcher. Your API reference now acknowledges a seconds-long window after a restore where exec can answer 502 while the VM is live. Ours lasted over ten minutes, so a `starting` state is what would tell the two apart.

## 5. Every exec dies at about 29 s with 502 `exec failed`, whatever `timeoutMs` says

**Called.** `POST /sandboxes/<sandbox-id>/exec` with `{"cmd": "bash", "args": ["-c", "sleep 60; echo done"], "timeoutMs": 300000}` on a fresh base sandbox (wsp-map#154).

**Came back.** HTTP 502 `{"error":"exec failed"}` after 28.9 s. `sleep 150` the same after 28.8 s. `sleep 10`, `20` and `25` returned 200 with their output (the 25 s one took 29.85 s wall). `sleep 35` and `45` were cut at 28.9 s. 2026-09-05 04:10 to 04:30 UTC (wsp-map#154).

**Expected.** The command to run to `timeoutMs`, as it did the day before: on 2026-09-04 the same endpoint ran Homebrew installs for minutes inside one exec (wsp-map#154). Or a documented cap with a non-retryable status and a code.

**How often.** Every exec over about 29 s from 2026-09-05 04:00 UTC, still in place when we last measured it later that day; our canary will tell us when it moves (wsp-map#154). A shorter version of the same shape appeared during two earlier spells on 2026-09-02: 08:59 to 09:10 UTC, every exec over about 15 s answered 502 `exec failed` while sub-second execs worked and one create took 123 s; and 18:40 to 18:50 UTC, preview-edge GETs answered 502 after 5 to 11 s and REST exec 502 after 36 s while an already-open WebSocket through the same edge kept working (wsp-map#4). Both cleared themselves.

**Cost to us.** Our golden build died at its tools stage at 89 s and the builder was killed (wsp-map#154). We moved every guest command that can run past 20 s to a detached launch (`setsid nohup ... &` with the exit code written to a file) polled by short execs, and capped every remaining inline exec at 20 s (wsp-map#154). Because the 502 sits in the retryable class, our client retried it twice, so a raw long exec took about 89 s to fail (wsp-map#154). That is one module, a per-launch claim directory so a retried launch does not start the script twice, and a canary that posts a 40 s sleep so we learn when the cap moves (wsp-map#154).

**Smallest change.** Document the cap and return a non-retryable 4xx with a code (`ExecTimeout`) when it is hit. Honouring `timeoutMs` up to your real ceiling would be better still, and we would delete the detached launcher.

## 6. `diskGb` on a desktop is accepted and ignored, and unknown fields are accepted silently

**Called.** `POST /sandboxes` with `{"kind": "desktop", "template": "default", "diskGb": 10, ...}`, then `lsblk` and `df` inside (wsp-map#40, wsp-map#42).

**Came back.** 201 and a 4 GB `vda` with about 572 MB free. Same on the `code` and `workstation` templates. 2026-09-02 (wsp-map#40, wsp-map#4). On kind `sandbox` the same field was accepted and ignored on 2026-09-02 (`diskGb: 20`, 4 GB `vda` every time) (wsp-map#4), refused on one host pool at 2026-09-04 00:30 UTC with `does not support: disk.size`, and honoured from 2026-09-04 17:22 UTC on: `diskGb: 20` gave a 20 GB root, `diskGb: 21` was refused with 400 `{"code":"ValidationError","error":"diskGb: must be between 1 and 20","field":"diskGb"}` (wsp-map#4, wsp-map#118). So sandboxes are fixed; desktops we have not re-measured since 2026-09-02, and your 2026-09-04 API reference says diskGb is honoured on fresh creates, so this half may be done. The unknown-fields half stands. In the same probe, `disk_gb: 20` (the changelog's spelling at the time) returned 201 and booted the 4 GB default; unknown fields are not refused (wsp-map#118).

**Expected.** Either the disk asked for, or a 400.

**Cost to us.** Desktop-kind goldens are off the table: 572 MB does not hold Node plus one agent installer (wsp-map#42). Every create that asked for more disk now reads `diskGb` back from GET to check it landed (wsp-map#118).

**Smallest change.** Refuse unknown top-level fields with 400, and honour or refuse `diskGb` on desktops. None of the desktop templates ships Node while the sandbox base does; a line in the template docs would save people an hour (wsp-map#40).

## 7. `GET /sandboxes` sometimes omits paused machines that `GET /sandboxes/:id` returns

**Called.** `GET /sandboxes` with no filter and with `state` filters, then `GET /sandboxes/<sandbox-id>` for a machine we had paused (wsp-map#5).

**Came back.** The listing was empty under every filter while a paused machine existed; `GET` by id returned it, `connect` worked, and a resume took 4.9 s with its disk intact. 2026-09-01 16:27 UTC, and once overnight before that; at about 16:35 UTC the same machine listed normally (wsp-map#5). A third sighting on 2026-09-03 23:58 UTC: six consecutive listing calls over ten minutes omitted a paused machine that GET returned as `paused` (our probe notes; not on a ticket). On 2026-09-04 the same paused machine appeared in all twelve listing calls (wsp-map#118).

**Expected.** The listing to be the set of machines on the account.

**Cost to us.** We persist every machine id ourselves, treat the listing as best effort, and never let the listing alone decide that a machine is gone: a missing row gets one `GET` by id before we act (wsp-map#277, wsp-map#360).

**Smallest change.** Whatever makes the listing consistent with GET by id. If paused machines can lag out of the listing by design, say so in the docs and we will stop treating it as a flake.

## 8. `ConcurrencyLimitExceeded` says `retryable: true`; your error table says free a slot

**Called.** `POST /sandboxes` with two sandboxes already running (wsp-map#4).

**Came back.** 429 `{"code":"ConcurrencyLimitExceeded","error":"Too many concurrent sessions","detail":"2 running session(s) and 0 create/resume(s) in progress hold 2 of 2 slot(s)","cause":"org_cap","retryable":true}`. 2026-09-05 10:08 UTC (wsp-map#4). Re-run against the current API, the body is the same and `retryable` is still true, now beside a `cause` field.

**Expected.** One answer. The error codes page says this one is not retryable.

**Cost to us.** Small. We special-case the status and ignore the flag.

**Smallest change.** `retryable: false` on this body.

---

## API facts we inferred and would like confirmed

- **`createdAt` is not a creation time.** On a never-paused, never-exec'd sandbox, GET read `createdAt` 6.4 s late at two minutes, 306 s late at ten minutes and 3606 s late at 65 minutes, in five-minute steps with a fixed fraction, and the listing showed the same moved value (wsp-map#104). It moves to the resume time on every resume, 3 of 3 (wsp-map#4). On 2026-09-07 two machines created a day apart both read `01:34:02` after a wake (wsp-map#358). Inferred: it is the last boot or heartbeat of the host agent. If so, the field name is misleading, and a `bootedAt` beside a real `createdAt` would help. (Confirm.)
- **`expiresAt` is a rolling idle window on running machines only.** About 40 minutes ahead and renewed while we talk to the machine; stale and ignored on paused machines (wsp-map#277). Your docs say a per-machine GET resets the idle timer, and we measured that exec and connect do too, while the account listing does not (wsp-map#51; our probe notes, 2026-09-03). (Confirm that the listing does not count as activity.) A `timeoutMs` of six hours came back as five (wsp-map#104); your API reference documents that as the plan maximum clamp, so no question there. One question on the default: the API reference says the sandbox idle default is 2 h, the sandboxes prose page says 30 minutes. Which one is live?
- **The Starter cap is two concurrent sessions, counting running machines and in-flight creates and resumes.** From the 429 body above (wsp-map#4). Paused machines do not count: with one paused workspace on the account, one slot read as free (wsp-map#4), which matches your pricing page and your API reference (1 on Free, 2 on Starter, 10 on Professional).
- **On 2026-09-01 every machine came up with 2 vCPU regardless of the requested cpu** (wsp-map#4). Your API reference says cpu is an integer 1 to 8, not plan-gated. Is Starter clamped, and if so where is that written? (Measured 2026-09-01 and 2026-09-04; on 2026-09-07 a cpu: 2 machine showed nproc 2 with CPUs 2 to 15 offline, so we have not re-checked cpu: 4 since.) - **Metadata takes at least seven keys and a 60-character free-text value with spaces and punctuation** (`POST /sandboxes` answered 201; the create reply does not echo metadata, GET does). 2026-09-07 05:52 UTC (wsp-map#360). Your API reference puts keys and values at 1024 characters each and does not state a key count.
- **No request id on any reply.** On 2026-09-07 the headers on a 200 list and on a 404 were `date`, `content-type`, `content-length` only (wsp-map#358). On the current API a reply also carries `via` and `alt-svc` from your edge, but still no request or correlation id. Every bug above is reported with a UTC time and a sandbox id because that is all we have.
- **The create reply is `{sandboxId, kind, controlUrl, expiresAt}` only**; `diskGb`, `createdAt` and `metadata` appear only on GET and in listing rows (wsp-map#118). (Confirm intended.)
- **Killed machines never read a `gone` or `releasing` state.** `DELETE /sandboxes/:id` answered 200 `{"ok":true}` in 0.26 to 2.2 s and the very next GET was 404, 8 of 8; `DELETE` on an already-gone id also answered 200 (wsp-map#4). Your API reference now settles this: `GET /sandboxes/:id` 404s by design, while `GET /desktops/:id` reports `status: gone` and the list `state` filter names `releasing` and `gone`. We would still take a `gone` state on the sandbox route, so a poller can tell a kill from an outage.
- **The exec environment carries PATH and nothing else.** No HOME or USER, so a login shell expands `$HOME` to empty; `cmd` is run as a binary name with no shell, so `{"cmd": "echo hi"}` answers `exitCode: -1` with empty output on a healthy machine (wsp-map#131, wsp-map#4). Documenting both would save every integrator a bad day.
- **JSON bodies cap at 16 KB, exec included.** A 17 KB exec body answered 413 `Payload Too Large` (wsp-map#256). Your errors page now puts the 16 KB 413 on the browser gateway only, but we measured it on the VM `/exec` route and have not re-measured it since. We did not bisect the exact figure, and the error body does not carry it (wsp-map#209).
- **The signed upload URL takes a single PUT up to exactly 32 MiB.** 200 at 32 MiB, 413 `{"error":"Payload Too Large","limit":33554432}` from 33 MiB. The signed download URL has no such cap: a 40 MiB object came down whole in 10.9 s (wsp-map#110). Is there a multipart or resumable upload we should be using?
- **A snapshot of a 20 GB-disk sandbox reports `sizeBytes` of about 25.2 GB in `GET /snapshots`**, larger than the disk (our probe notes, 2026-09-05; not on a ticket). With storage billed from 2026-10-01 at $0.05 per GB-month past 10 GB free, we would like to know what a fork's snapshot counts as against its parent, and whether deduplication is planned (wsp-map#4, wsp-map#119).
- **Docker cannot run containers in a sandbox.** dockerd on the base image comes up only in vfs mode with no bridge, and runc fails even on hello-world. The guest kernel is 6.6.30 without overlayfs and full netfilter. 2026-09-01 01:38 UTC (wsp-map#4, wsp-map#58). If containers are out of scope by design, one line in the docs would save the next person the hour.

## Four asks, in order

1. **A machine is never removed without a state we can read, and a snapshot is never the thing that kills it.** Bugs 1 and 2 are the same ask from two sides: a running sandbox should end in `releasing` with a reason for long enough to be seen, its disk should be kept or snapshotted when the platform drops it, and a refused snapshot should leave the machine running. A request id header on every reply belongs here too; without it we cannot give you anything better than a timestamp.
2. **A plan above Starter, with the numbers.** Our product is many workspaces per person. Two concurrent machines stop that at the door: a golden build alone uses both slots (builder plus smoke fork), so a single workspace cannot run beside a rebuild (wsp-map#4). Your pricing page says Professional lifts that to 10 concurrent and 24 h sessions, and your API reference says cpu (1 to 8), memMb (up to 16 GB) and disk (1 to 20) are not plan-gated. What is not written anywhere is whether Starter clamps cpu, and whether a guest is expected to see every vCPU on its record. On storage, your API reference says volumes are s3fs mounts with an advisory `sizeMb`. That fits blobs and caches, not a git worktree or node_modules. Is a block-backed volume planned, and what are the read and write speeds of an s3fs volume from inside a sandbox? And the price for the tier that fits (wsp-map#4).
3. **Readiness and limits on the record, not in our retry loops.** `running` only after the guest answers (bug 4); the exec cap documented and returned as a non-retryable code, or `timeoutMs` honoured (bug 5); `retryable` in the body agreeing with the error table (bug 8). Each of those lets us delete a workaround.
4. **A way to grow a machine, or a written answer that there is none.** Your API reference has no resize endpoint, and it says a machine started from a snapshot or a fork keeps the snapshot's disk and ignores `diskGb`. So a golden's size is fixed the day it is sealed, and every workspace forked from it inherits that size. Our first probes on 2026-09-01 also found every machine came up with 2 vCPU on Starter whatever cpu we asked for. We would take either a resize endpoint, or a documented answer on whether a fork can be created with more cpu, memMb or diskGb than its source. Today the only path we know is to rebuild the golden.

We have the probe scripts, the raw responses and the sandbox ids for everything above and will send any of it on request. We would also be glad to run a candidate fix against our canaries before it ships.

Aditya Singhi
wsp, https://github.com/Zingzy/wsp, https://wspx.vercel.app
admin@spoo.me
