# Daemon

The Rust daemon, root on a box. Paths are under daemon/ unless they start at the repo root.

## How it works

An agent writes every byte of a workspace and the daemon is root: treat every file, link, FIFO and git config there as hostile.
git for a workspace on an owned computer runs inside it (`Inside`), since hooks and config are agent code; a stopped one runs no git.
A daemon one version behind is normal: a box keeps what was deployed until `wsp add <name> --update`.

## Invariants

1. `beneath::file()` and the git roads' reads open one name at a time, follow no link and read under a cap: `a_link_anywhere_on_the_way_reads_as_no_file_and_a_file_past_the_cap_is_never_read()`.
2. A repository whose top sits above a root answers for that root alone: `git_diff_holds_to_the_root_when_the_repository_top_sits_above_it()`.
3. Git operands sit behind a separator in a `GitLine`; a root write by path names its reason: `git_runs_only_through_its_runner()`, `a_root_write_names_its_reason()`.
4. Every git through `run_git()` carries `GIT_ENV` and the work score: `every_git_call_carries_optional_locks_off_and_the_c_locale_and_runs_at_the_work_score()`. sshd, ssh-keygen and the detached rm go by full path; git runs off the daemon's PATH (no test yet).
5. A ports watch naming roots sees what they hold; one naming none, the host's own, sees the whole computer: `a_watch_sees_what_its_roots_hold_and_one_that_names_none_sees_the_whole_machine()`.
6. An op the daemon lacks answers `unknown_op()`: `an_unknown_op_is_named_never_silent()`. A field the wire leaves out is optional: `a_field_the_wire_leaves_out_is_optional_and_never_null()`.
7. Shipped daemon sources that moved under an unchanged version fail `packages/host/test/daemon-content.test.ts` on main.
8. The token file is read at every auth frame, so the host rotates it with no restart: `checks_each_auth_frame_against_the_token_file_as_it_is_now()`.
9. A thread keeps `REFS_PER_THREAD` checkpoint refs, a restore's `-before-` refs counted: `a_thread_keeps_its_newest_hundred_refs_with_the_before_refs_counted_and_no_other_threads_go()`.

## Traps

- std::fs on `rootfs.join(...)` follows a link the workspace planted onto the box's `/root/.ssh`; write with `write_file_inside()`, which also never waits on a FIFO (#1523).
- Never reply with git's own read of a worktree file (diff body, hash-object, a clean filter): it follows a link swapped in after the listing. Use `untracked::seen()` (#1517, #1534).
- `Runs::on_this_side()` has no default on purpose: a new way of running says where it opens the folder, and its swap test swaps the top too (#1534).
- A second copy of a helper drifts: a temporary index goes through `with_index()`, a no-link open through `beneath::file()` (#1434, #1534).
- The files pane's `read_file_bounded()` and the search's `read_unlinked()` in `crates/wsp-daemon/src/fs.rs` open a whole path, no-follow on the last name only and blocking: copy neither; `write_file()` is the model (#1523, #1534).
- `git()` in `crates/wsp-runtime/src/copy_road/rules.rs` sets only the prompt and the locale, not `GIT_ENV` or the work score (#1766).
- Park a folder you may rename back under `HOLDING_PREFIX`; only once git agrees rename it to `ASIDE_PREFIX`, which every sweep takes (#1607).
- git's reason is its first fatal or error line, not its last line, often a hint: use `GitRun::why()` (#1607).
- A field made required on a frame the daemon sends blanks the host's pane for an older daemon; `seq` on proc.snapshot stays optional (#1720).
- `refused_port()`'s doc claims a rule XNU's v6 bind breaks; assert with `squatter_binds()` (#1726).

## One home for

| Rule | File | Function |
|---|---|---|
| a no-link read under a held folder | `crates/wsp-daemon/src/beneath.rs` | `beneath::file()` |
| a file written inside a workspace | `crates/wsp-runtime/src/bundle.rs` | `write_file_inside()`, `write_file_in()` |
| a git command line | `crates/wsp-runtime/src/git_line.rs` | `GitLine` |
| a path inside the daemon's roots | `crates/wsp-daemon/src/paths.rs` | `resolve_inside()` |
