# Solari bug bundle: validation change log, 2026-09-23

Written while validating `thoughts/outreach/solari-bug-bundle-final-2026-09-23.md` before it goes to Solari. Sources checked, in order: the report; every wsp-map ticket it cites, with comments; `~/solari-poc/RESULTS.md` and `~/.claude/skills/solari/references/api.md` for the lines marked "our probe notes"; Solari's live docs and changelog read 2026-09-22 21:12 to 21:20 UTC; the wsp-map search for provider tickets; and live probes against api.getsolari.com on 2026-09-22 (this session runs in the owner's evening; `date -u` read 2026-09-22 21:xx UTC throughout).

Real sandbox ids, snapshot ids and the account key stay here and in `probes/`, never in the report. The report keeps placeholders.

Live-probe budget used: one 429-refused create at 2026-09-22 21:12:08 UTC (bug 8, made no machine). Nothing else ran. Both Starter slots stayed held by the owner's own running builders ("builds a", "builds b") for the whole window, and the rules forbid me to pause or delete a machine I did not create, so no slot ever freed. The poller (`probes/wait-slot.sh`) watched from 21:24 to 22:26 UTC and timed out with two running throughout. The single-sandbox probes for bugs 5, 6, 7 and the fact list did not run. The scripts are in `probes/` ready to fire, and what each would have done is recorded below.

---

## Four lists

### Confirmed as written (checked against the ticket or probe note, same endpoint, status, body and time)

- Bug 1, the snapshot 502 that dropped the running builder: every measured sentence traces to wsp-map#358 and wsp-map#355, and the earlier 2026-09-01 form to `RESULTS.md`. (The inferences carry the "inferred" label.)
- Bug 2, pause 409 then 404: every sentence traces to wsp-map#277 (the 01:21 direct watch, the 09:55 to 10:21 and 17:58 to 18:04 clusters, the rolling `expiresAt`) and wsp-map#358.
- Bug 3, the resume that hangs after an out-of-memory pause: traces to wsp-map#4's comments of 2026-09-06 13:02 to 13:15 UTC.
- Bug 4, the running zombie after resume: both instances (2026-09-02 and 2026-09-03) trace to wsp-map#4's comments and wsp-map#85.
- Bug 5, the exec cut at about 29 s: the numbers trace to wsp-map#154. (Re-measure did not run, both slots held. Ticket support confirmed.)
- Bug 7, the listing that omits paused machines: the three sightings trace to wsp-map#5 (2026-09-01) and the `api.md` probe note (2026-09-03 23:58 UTC), correctly labelled "not on a ticket".
- The "inferred" label is present on every sentence in the report that is a reading rather than a measurement (bug 1's relocation, bug 2's gateway-restart reading, bug 4's provider-side pause).

### Changed

- **Intro date.** The report says "Your 2026-09-14 update". Solari's changelog carries no 2026-09-14 entry; the infrastructure move is dated 2026-09-10 ("New infrastructure, stronger session guarantees"), the compute-reliability fixes 2026-09-21, per-session metering 2026-09-18, higher stealth concurrency 2026-09-16. Changed the date to 2026-09-10 and named the 2026-09-21 fixes, since those are what bear on the bugs.
- **cpu and memMb ceilings (facts list, ask 2, ask 4).** The report says "cpu is an integer 1 to 16" and repeats "cpu (1 to 16)". Today's docs (POST /sandboxes, the Sandboxes prose page, the VM API page) all say **cpu 1 to 8, memMb up to 16384 (16 GB)**. The July changelog's "1 to 16 vCPU and up to 64 GB" is gone. Changed 1-16 to 1-8 and noted the 16 GB memory ceiling. (A live over-range rejection check did not run, both slots held.)
- **Bug 8, the 429 body.** Re-measured 2026-09-22 21:12:08 UTC: the body still carries `"retryable":true` and now also `"cause":"org_cap"`; the `detail` wording is byte-identical to the report's. The errors page and the API reference both still say 429 is not retryable and no client retries it. So the contradiction stands as written; added the new `cause` field to the quoted body.
- **The "no request id" fact.** Still true that no reply carries a request or correlation id, but the header set is no longer "date, content-type, content-length only": every reply this session also carried `via: 1.1 google` and `alt-svc` (the Google Cloud edge from the 2026-09-10 infrastructure move). Reworded so the claim is "no request id" without the false "only these three headers".
- **Bug 6, the desktop half.** The 2026-09-21 changelog says desktop disk size is now honoured at create ("You can now set a desktop's disk size at create time... Asking for more than the host allows now fails immediately with the maximum named") and that the vCPU-not-onlined fault is fixed for both kinds. The report already hedges the desktop-diskGb half as "may be done". The live re-measure (a desktop with diskGb 10) did not run, both slots held, so the report keeps that hedge.
- **Bug 6, the 16 KB body-cap parenthetical.** The errors page now scopes 413 to the browser gateway only ("413 | Browser gateway only"). wsp measured 413 on the VM `/exec` route (wsp-map#256). The report now says the errors page scopes the 16 KB 413 to the browser gateway while wsp measured it on `/exec`, unre-measured. The live re-measure (a 17 KB exec body) did not run, both slots held.

### Removed

- Nothing removed yet. Bug 6 and its unknown-fields half, and the desktop-diskGb sentence, are candidates for a cut once the live re-measure lands (if desktops now honour diskGb, that half of bug 6 goes and only the unknown-fields half stays).

### Added

- **Docs that bear on bugs 1 to 4** (added as short, dated notes; no new bug, since none is re-measurable without machines and running workloads):
  - Bugs 1, 2, 4: the 2026-09-10 move to "fully redundant infrastructure across multiple zones" and the 2026-09-21 "Deploys no longer interrupt sandbox and desktop creation, a warm standby always answers while another instance restarts" speak to the cluster-vanishing and the post-resume zombie, whose inferred cause was a gateway restart or deploy. Named so Solari can say whether those windows are closed.
  - Bug 1: the 2026-09-22 changelog "A snapshot that cannot be restored now tells you so, with the reason, instead of failing as a capacity error", and the new `SnapshotNotRestorable` (409, `retryable:false`) code in the API reference, are the shape of the code bug 1 asked for, though the 502 "host failed the snapshot" path is unchanged.
- **The gone-vs-404 question is now answered by the docs.** The API reference documents the split as deliberate: `GET /sandboxes/:id` 404s ("all indistinguishable by design"), `GET /desktops/:id` reports `status: "gone"`, and the list `state` filter names `releasing` and `gone`. Noted in the facts list so the "confirm which is intended" reads as answered.
- **The Starter cap and paused-not-counting fact is now documented**, not only measured: POST /sandboxes 429 says "1 on Free, 2 on Starter, 10 on Professional" and pause "stops counting against your concurrency limit". Confirmed live today (two running fired the 429 while three paused machines coexisted).

---

## Per item, with evidence

### Bug 1: snapshot 502, running sandbox then gone

- "POST /sandboxes/<id>/snapshots with body {"name":"golden-v1"}... created 28 minutes earlier... GET read running throughout (wsp-map#358)." Confirmed. wsp-map#358 body: "The provider answered POST snapshot with 502 Failed to snapshot sandbox after 17 s", "28 minutes of build gone", run at 2026-09-07 01:19 UTC.
- "HTTP 502 after 17 s. The body's error text was Failed to snapshot sandbox, with no code field." The 17 s and the message are in wsp-map#358. "No code field" is directly attested only for the 2026-09-01 form (`RESULTS.md` line 176, "a bare 502... no code"); wsp-map#358 quotes the message without a code, which is consistent. Left as written; the claim is sound.
- "The next GET answered 404... absent from GET /sandboxes... GET /snapshots had no new row. 2026-09-07 01:19 UTC." Confirmed, wsp-map#358 body verbatim.
- "An earlier form on 2026-09-01... resumed answered the same bare 502 to three snapshot attempts in a row starting 01:28 UTC, while fresh sandboxes and short pause-resume sandboxes snapshotted fine (wsp-map#4)." Confirmed against `RESULTS.md`: line 40 "P2 golden loop, 2026-09-01T01:28:40.341Z", line 41 "golden base v1 idle-paused overnight; resumed machine refused snapshots (3x 502)", line 176 the bare-502 boundary. The evidence is the PoC note that wsp-map#4 carries; the ticket citation is therefore the outreach ticket, not a measurement ticket. Acceptable as written.
- "its createdAt had moved from 00:51:14 to 01:04:02 while it ran... Inferred: the machine was rebooted or moved at 01:04." Confirmed and labelled inferred. wsp-map#358 comment 5563798310 corrects the earlier "relocation" wording: createdAt is a boot/heartbeat stamp that drifts anyway, so the reboot reading rests on the stamp jump plus the npm stall together, which the sentence states. Fine.
- Re-measurable? No. A snapshot costs a machine and the incident needs a built, running builder. Checked against tickets only, as the task directs.
- Added note (docs): the 2026-09-22 "snapshot that cannot be restored now tells you so" change and the `SnapshotNotRestorable` code are adjacent to the ask; the 502 host-failed path is unchanged. To fold into bug 1's "smallest change" as a "you have started on this" line.

### Bug 2: pause 409, then 404 six seconds later

- The whole "came back" block (409, six seconds later 404, absent from listing, 2026-09-07 01:21 UTC; the two earlier "Not pausable" bodies). Confirmed. wsp-map#277 comment 5563706476 (the 01:21 direct watch, the three rolling `expiresAt` reads 01:56:58, 01:58:27, 01:58:32) and comment 5561114751 (the "Not pausable" then "Not found" at 18:04).
- The frequency table's four rows. Confirmed row by row against wsp-map#277 (body, comment 5561114751, comment 5563706476) and wsp-map#358.
- "In every case the paused sandboxes on the account survived and only running ones vanished." Confirmed, wsp-map#358 ("the paused machines survived") and wsp-map#277 ("lists only two sandboxes... both paused").
- The inferred paragraph's doc quotes (the 409 meaning "the host no longer knows this VM"; paused records durable across a redeploy; the in-memory snapshot store; the two reapers). All four verified word-for-word in today's API reference (POST /sandboxes/:id/pause, GET /sandboxes/:id, POST /snapshots/:id/promote, POST /sandboxes/:id/timeout). Fine.
- The `expiresAt` aside (40 min ahead, rolls forward 23:15:04 then 23:16:35, stale on paused). Confirmed, wsp-map#277 comment 5562672773 verbatim.
- Re-measurable? No (needs running machines vanishing across a deploy). Checked against tickets only.
- Added note (docs): the 2026-09-10 multi-zone infrastructure and the 2026-09-21 "a warm standby always answers while another instance restarts" are the fix for the inferred cause. Fold into bug 2's inference as "your 2026-09-10 and 2026-09-21 notes may already close this; tell us and we re-run".

### Bug 3: resume hangs after an out-of-memory pause

- The whole bug (2 vCPU/4 GB, guest 3.8 of 3.9 GB, load 6; pause took minutes; resume no reply, curl 000 at 120 s and again at 300 s; GET still paused; console resume 504; 2026-09-06 13:02 to 13:15 UTC). Confirmed against wsp-map#4 comments 5559396779 and 5559448656.
- Re-measurable? No (needs a specific out-of-memory paused machine). Checked against the ticket only.
- Note (docs): the 2026-09-21 "Requests that cannot be placed now fail in about 20 seconds with a Retry-After header, instead of holding your connection open for four minutes" is the class of fix but is about admission, not resume; the resume-hangs-forever with no status is still not documented behaviour. Bug 3 stands.

### Bug 4: running zombie after resume

- Both instances (2026-09-02 ~18:50 UTC, exec 502 after 8 to 36 s and edge 502 after 5 to 11 s for 10+ min, fresh sandbox 759 ms; 2026-09-03 ~09:45 UTC, sat overnight, exec 38 s to 502, fresh 668 ms). Confirmed against wsp-map#4 comments 5514834156 and 5523761169 and wsp-map#85.
- Re-measurable? No (needs pause/resume plus a running workload). Checked against tickets only.
- Candidate add: the API reference acknowledges a seconds-long post-restore window ("a concurrent upgrade can get a transient 502 guest_unreachable while the VM is in fact live"); wsp's lasted 10+ minutes. One sentence would sharpen bug 4. Optional.

### Bug 5: exec cut at about 29 s (RE-MEASURE DID NOT RUN, BOTH SLOTS HELD)

- The numbers (sleep 60 and 150 cut at ~28.9 s; sleep 25 passed at 29.85 s wall; sleep 35/45 cut) trace to wsp-map#154 body and comment 5549279606. Confirmed as ticket-supported.
- Task asks for a fresh-sandbox re-measure. Held: probe `probe-a2.sh` (a6-sleep25, a6-sleep40) will re-run sleep 25 and sleep 40 with timeoutMs 300000 and record the wall time and status. Today's docs still describe timeoutMs as "Per-command budget" with no documented cap and 502 as "The host or guest could not run the command", so if the cap persists it remains undocumented. Result to fill in.

### Bug 6: diskGb on a desktop ignored; unknown fields accepted (RE-MEASURE DID NOT RUN, BOTH SLOTS HELD)

- The sandbox-diskGb history (accepted+ignored 2026-09-02, refused 2026-09-04 00:30, honoured from 2026-09-04 17:22, diskGb 21 → 400 ValidationError) traces to `api.md` lines 29 to 31 and wsp-map#118. Confirmed.
- The desktop half (4 GB vda, ~572 MB free, 2026-09-02) traces to wsp-map#40 and wsp-map#42. The 2026-09-21 changelog says desktop disk size is now honoured. Held: probe `probe-d.sh` creates kind desktop with diskGb 10 and reads lsblk/df inside. Result to fill in; if honoured, cut the desktop-diskGb half.
- The unknown-fields half (disk_gb:20 → 201 booting the 4 GB default; unknown fields not refused) traces to `api.md` line 30. Held: probe `probe-a.sh` sends `disk_gb`, `bogusTopLevel` on the create and records whether it 201s or 400s. Today's docs say "A present-but-invalid field is rejected with 400 ValidationError" but that is about invalid values of known fields, not unknown top-level keys. Result to fill in.

### Bug 7: listing omits paused machines (RE-MEASURE DID NOT RUN, PARTIAL EVIDENCE NOW)

- The three sightings trace to wsp-map#5 (comments 5497116035, 5497217678) and `api.md` line 12 (2026-09-03 23:58 UTC, "not on a ticket", correctly labelled). The 2026-09-04 "all twelve listing calls" is `api.md` line 37; the report cites wsp-map#118, which is the same 2026-09-04 probe session but is the idempotency ticket, so the citation is loose. Minor.
- Partial re-measure already in hand: across every `GET /sandboxes` this session (21:11, 21:16, 21:19 UTC and the poller's calls), all three of the account's paused machines appeared every time. So the listing currently includes paused machines. The full re-measure (pause my own sandbox, then six listing calls) is held on the slot; probe `probe-a4.sh` does it.

### Bug 8: 429 says retryable:true (RE-MEASURED)

- Re-measured 2026-09-22 21:12:08 UTC. Raw body: `{"code":"ConcurrencyLimitExceeded","error":"Too many concurrent sessions","detail":"2 running session(s) and 0 create/resume(s) in progress hold 2 of 2 slot(s)","cause":"org_cap","retryable":true}`. HTTP 429. The `detail` is byte-identical to the report's; the body adds a `cause:"org_cap"` field. The errors page and the API reference both still say 429 is not retryable and no client retries it, and the API reference adds "retryable:false cannot stop a 5xx retry... A refusal that must reach you immediately is therefore a 4xx", which is exactly bug 8's ask. Confirmed as written, quoted body updated with `cause`.

### API facts

- **createdAt drift.** Re-measure held (probe reads GET at ~2 min and ~10 min after create); the report's 5-minute-step and resume-move claims (wsp-map#104, wsp-map#4, wsp-map#358) stand as prior measurements.
- **expiresAt rolling / stale on paused.** Re-measure held (GET and exec reset behaviour). The docs still contradict themselves on the default: the API reference says "Default 2h for sandbox", the Sandboxes prose page says "defaults to 30 minutes", both read today, so the report's open question stands.
- **Starter cap two, paused not counting.** Confirmed live today and now documented; reworded from "would like confirmed" to "measured and now in your docs".
- **cpu ceiling.** Changed 1-16 to 1-8 (docs); over-range live check held. The 2026-09-01 "every machine came up 2 vCPU" is a prior measurement; the cpu:4 re-measure is held (probe reads nproc/lscpu/online/offline; the 2026-09-21 fix says hot-added cores are now onlined at start).
- **metadata 7 keys, 60-char value.** Confirmed, wsp-map#360 comment 5565713613; the report already carries the 1024-char doc limit.
- **no request id.** Reworded (via/alt-svc now present); no correlation id still.
- **create reply fields.** Re-measure held; docs and `api.md` line 31 both support {sandboxId, kind, controlUrl, expiresAt}.
- **killed machines never read gone; DELETE 200 then 404; DELETE on gone 200.** Re-measure held (probe a4 b4). The "your docs say gone" question is now answered by the docs (sandbox 404 vs desktop gone, deliberate).
- **exec env PATH only, no HOME/USER, echo hi → -1.** Re-measure held (probe a4-env, a4-noshell). The docs now document both (no shell; env and user deliberately omitted).
- **16 KB body cap on /exec.** Re-measure held (probe a7, 17 KB vs 15 KB). Docs now scope 413 to the browser gateway, contradicting the measurement.
- **32 MiB upload cap, no download cap.** Re-measure held (probe a3/a8, 32 MiB PUT vs 33 MiB PUT). Docs do not state the cap.
- **snapshot sizeBytes ~25.2 GB.** Not cleanly re-measurable with one fresh (empty) sandbox; a fresh 20 GB disk snapshot is sparse. Left as the prior probe note; the docs explain it (snapshots are self-contained disk+RAM).
- **Docker cannot run containers.** Partial re-measure held (probe a4-env reads `uname -r`); a full dockerd test is out of scope. wsp-map#58 and the field note stand.

---

## What I could not check, and why

- **Bugs 1 to 4** cannot be reproduced within the budget: they cost machines and need running workloads, and the task directs checking them against the tickets only. Done.
- **The live single-sandbox probes (bugs 5, 6, 7, the fact list, desktop diskGb, cpu:4)** did not run: both Starter slots stayed held by the owner's own running builders for the whole window, which I must not pause or delete, so no slot freed. The poller ran 21:24 to 22:26 UTC and timed out with two running throughout. These stay as ticket-and-docs findings, with the probe scripts ready in `probes/` to run when a slot is free.
- **The snapshot sizeBytes ratio** needs a machine with a full 20 GB disk of real data; a fresh probe sandbox cannot reproduce the 25.2 GB figure.
- **The two paused machines behind bug 3 and the vanished machines behind bugs 1, 2, 4** are gone or are the owner's; nothing to re-read.
