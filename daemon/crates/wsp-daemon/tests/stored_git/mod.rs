// SPDX-License-Identifier: AGPL-3.0-only
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use super::*;
use crate::git::parse_porcelain_v2;
use wsp_frames::DaemonErrorCode;

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn commit(cwd: &Path, file: &str, text: &str) {
    std::fs::write(cwd.join(file), text).unwrap();
    git(cwd, &["add", file]);
    git(cwd, &["commit", "-q", "-m", text]);
}

/// An origin with three commits, a clone of it on a branch that tracks origin/main, two commits of the clone's
/// own and one more on origin fetched: ahead two, behind one.
fn tracking_clone() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("origin");
    std::fs::create_dir(&origin).unwrap();
    git(&origin, &["init", "-q"]);
    for n in 0..3 {
        commit(&origin, "a.txt", &format!("origin {n}\n{}", "shared line\n".repeat(200)));
    }
    let copy = dir.path().join("copy");
    git(dir.path(), &["clone", "-q", &origin.to_string_lossy(), "copy"]);
    git(&copy, &["checkout", "-q", "-b", "fix/cart", "--track", "origin/main"]);
    commit(&copy, "b.txt", "mine 1\n");
    commit(&copy, "b.txt", "mine 2\n");
    commit(&origin, "a.txt", "origin 3\n");
    git(&copy, &["fetch", "-q"]);
    (dir, copy)
}

/// What git itself reads for the branch, for the cases that hold this reader to it.
fn by_git(copy: &Path) -> GitBranch {
    parse_porcelain_v2(&git(copy, &["status", "--porcelain=v2", "--branch", "-z"])).0
}

/// What git itself counts as held by no remote: every branch and every worktree's HEAD, less the remotes and the
/// seeded refs. The reader is held to it on every shape below.
fn unpushed_by_git(copy: &Path) -> u64 {
    let mut args = vec!["rev-list".to_owned(), "--count".to_owned(), "--branches".to_owned()];
    let trees = git(copy, &["worktree", "list", "--porcelain"]);
    args.extend(trees.lines().filter_map(|l| l.strip_prefix("HEAD ")).filter(|h| h.bytes().any(|b| b != b'0')).map(str::to_owned));
    args.extend(["--not".to_owned(), "--remotes".to_owned(), format!("--glob={}/*", wsp_frames::numbers::SEEDED_REFS)]);
    git(copy, &args.iter().map(String::as_str).collect::<Vec<_>>()).trim().parse().unwrap()
}

#[test]
fn counts_every_branch_detached_head_and_worktree_head_no_remote_has_less_the_seeded_ones_as_git_does() {
    let (_dir, copy) = tracking_clone();
    let read = |copy: &Path| unsaved(copy).unwrap().unwrap();
    assert_eq!(read(&copy), Unsaved { commits: Some(2), stashes: 0 });
    // Back on main with the two commits on a branch not checked out, which the checked-out branch's count misses.
    git(&copy, &["checkout", "-q", "main"]);
    assert_eq!(by_git(&copy).ahead, 0);
    assert_eq!(read(&copy).commits, Some(2));
    // A detached HEAD holding a commit no branch has.
    git(&copy, &["checkout", "-q", "--detach"]);
    commit(&copy, "c.txt", "detached\n");
    assert_eq!(read(&copy).commits, Some(3));
    assert_eq!(unpushed_by_git(&copy), 3);
    // A linked worktree's own detached HEAD, packed refs, and a stash.
    let tree = copy.parent().unwrap().join("tree");
    git(&copy, &["worktree", "add", "-q", "--detach", &tree.to_string_lossy(), "main"]);
    commit(&tree, "d.txt", "in the worktree\n");
    git(&copy, &["pack-refs", "--all"]);
    std::fs::write(copy.join("a.txt"), "edited\n").unwrap();
    git(&copy, &["stash", "-q"]);
    assert_eq!(read(&copy), Unsaved { commits: Some(4), stashes: 1 });
    assert_eq!(unpushed_by_git(&copy), 4);
    // What a seed carried over from the person's own folder is on their computer already.
    git(&copy, &["update-ref", &format!("{}/fix/cart", wsp_frames::numbers::SEEDED_REFS), "fix/cart"]);
    assert_eq!(read(&copy).commits, Some(2));
    assert_eq!(unpushed_by_git(&copy), 2);
}

#[test]
fn follows_a_link_at_refs_heads_or_worktrees_that_stays_inside_the_checkout_and_refuses_one_that_leads_out() {
    let (dir, copy) = tracking_clone();
    let tree = dir.path().join("tree");
    git(&copy, &["worktree", "add", "-q", "--detach", &tree.to_string_lossy(), "main"]);
    commit(&tree, "d.txt", "in the worktree\n");
    assert_eq!(unpushed_by_git(&copy), 3);
    let move_and_link = |rel: &str, to: &Path, target: &Path| {
        std::fs::rename(copy.join(".git").join(rel), to).unwrap();
        std::os::unix::fs::symlink(target, copy.join(".git").join(rel)).unwrap();
    };
    let restore = |rel: &str, from: &Path| {
        std::fs::remove_file(copy.join(".git").join(rel)).unwrap();
        std::fs::rename(from, copy.join(".git").join(rel)).unwrap();
    };
    for rel in ["refs/heads", "worktrees"] {
        let inside = copy.join(format!("kept-{}", rel.replace('/', "-")));
        let up = if rel == "refs/heads" { "../.." } else { ".." };
        move_and_link(rel, &inside, Path::new(&format!("{up}/kept-{}", rel.replace('/', "-"))));
        assert_eq!(unpushed_by_git(&copy), 3, "{rel}");
        assert_eq!(unsaved(&copy).unwrap().unwrap().commits, Some(3), "{rel}");
        restore(rel, &inside);
        let outside = dir.path().join(format!("out-{}", rel.replace('/', "-")));
        move_and_link(rel, &outside, &outside);
        assert_eq!(unpushed_by_git(&copy), 3, "{rel}");
        assert!(unsaved(&copy).unwrap_err().contains("leads out of the checkout"), "{rel}");
        restore(rel, &outside);
    }
}

#[test]
fn counts_a_branch_whose_name_is_not_utf8_as_git_does() {
    use std::os::unix::ffi::OsStrExt;
    let (_dir, copy) = tracking_clone();
    git(&copy, &["checkout", "-q", "--detach", "origin/main"]);
    let name = std::ffi::OsStr::from_bytes(b"refs/heads/caf\xff");
    let ran = Command::new("git").arg("update-ref").arg(name).arg("fix/cart").current_dir(&copy).status().unwrap();
    assert!(ran.success());
    git(&copy, &["branch", "-q", "-D", "fix/cart"]);
    assert_eq!(unpushed_by_git(&copy), 2);
    assert_eq!(unsaved(&copy).unwrap().unwrap().commits, Some(2));
}

#[test]
fn reads_a_fresh_clone_of_a_remote_holding_a_tag_off_every_branch_as_holding_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("origin");
    std::fs::create_dir(&origin).unwrap();
    git(&origin, &["init", "-q"]);
    commit(&origin, "a.txt", "one\n");
    git(&origin, &["checkout", "-q", "-b", "release"]);
    commit(&origin, "r.txt", "released\n");
    git(&origin, &["tag", "-a", "-m", "v1", "v1"]);
    git(&origin, &["checkout", "-q", "main"]);
    git(&origin, &["branch", "-q", "-D", "release"]);
    git(dir.path(), &["clone", "-q", &origin.to_string_lossy(), "copy"]);
    let copy = dir.path().join("copy");
    assert!(git(&copy, &["tag"]).contains("v1"));
    assert_eq!(unsaved(&copy).unwrap().unwrap().commits, Some(0));
}

#[test]
fn reads_a_git_folder_that_is_a_dangling_link_as_one_it_could_not_read() {
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(dir.path().join("gone"), dir.path().join(".git")).unwrap();
    assert!(unsaved(dir.path()).unwrap_err().contains("could not be opened"));
}

#[test]
fn counts_every_commit_where_there_is_no_remote_and_answers_none_for_a_folder_git_does_not_track() {
    let dir = tempfile::tempdir().unwrap();
    let alone = dir.path().join("alone");
    std::fs::create_dir(&alone).unwrap();
    assert_eq!(unsaved(&alone).unwrap(), None);
    git(&alone, &["init", "-q"]);
    assert_eq!(unsaved(&alone).unwrap(), Some(Unsaved { commits: Some(0), stashes: 0 }));
    commit(&alone, "a.txt", "one\n");
    assert_eq!(unsaved(&alone).unwrap(), Some(Unsaved { commits: Some(1), stashes: 0 }));
}

#[test]
fn a_tracking_branch_reads_as_git_reads_it_loose_packed_and_deltified() {
    let (_dir, copy) = tracking_clone();
    let want = by_git(&copy);
    assert_eq!((want.head.as_str(), want.upstream.as_deref(), want.ahead, want.behind), ("fix/cart", Some("origin/main"), 2, 1));
    let loose = status(&copy, "/root/app").unwrap();
    assert_eq!(loose.branch, want);
    assert_eq!((loose.root.as_str(), loose.entries.len(), loose.edits_unread), ("/root/app", 0, true));
    // Every object in one pack, deltas chained as deep as git will make them, and every ref in packed-refs.
    git(&copy, &["repack", "-q", "-a", "-d", "-f", "--depth=50", "--window=250"]);
    git(&copy, &["pack-refs", "--all", "--prune"]);
    git(&copy, &["prune-packed"]);
    assert!(!copy.join(".git/refs/heads/fix/cart").exists());
    assert_eq!(status(&copy, "/root/app").unwrap().branch, want);
    // And with every delta naming its base by id rather than by where it sits in the pack.
    git(&copy, &["-c", "repack.useDeltaBaseOffset=false", "repack", "-q", "-a", "-d", "-f", "--depth=50", "--window=250"]);
    assert_eq!(status(&copy, "/root/app").unwrap().branch, want);
}

#[test]
fn a_stopped_copys_stashes_are_counted_off_the_stash_log() {
    let (_dir, copy) = tracking_clone();
    assert_eq!(status(&copy, "/root/app").unwrap().stashes, None);
    for n in 0..2 {
        std::fs::write(copy.join("stashed.txt"), format!("{n}\n")).unwrap();
        git(&copy, &["add", "stashed.txt"]);
        git(&copy, &["stash", "-q"]);
    }
    assert_eq!(status(&copy, "/root/app").unwrap().stashes, Some(2));
}

#[test]
fn a_branch_with_no_upstream_counts_against_origins_default_branch() {
    let (_dir, copy) = tracking_clone();
    git(&copy, &["branch", "-q", "--unset-upstream"]);
    let read = status(&copy, "/root/app").unwrap().branch;
    assert_eq!((read.upstream, read.ahead, read.behind), (None, 2, 1));
    // A detached head reads as git reads it, and counts the same way.
    git(&copy, &["checkout", "-q", "--detach", "HEAD~1"]);
    let detached = status(&copy, "/root/app").unwrap().branch;
    assert_eq!((detached.head.as_str(), detached.oid, detached.ahead, detached.behind), ("(detached)", by_git(&copy).oid, 1, 1));
}

#[test]
fn a_repo_with_no_commits_and_a_shallow_clone_read_as_git_reads_them() {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    assert_eq!(status(dir.path(), "/root/app").unwrap().branch, by_git(dir.path()));
    let (_origin, copy) = tracking_clone();
    let shallow = dir.path().join("shallow");
    git(dir.path(), &["clone", "-q", "--depth=1", &format!("file://{}", copy.display()), "shallow"]);
    commit(&shallow, "c.txt", "on top\n");
    assert_eq!(status(&shallow, "/root/app").unwrap().branch, by_git(&shallow));
}

#[test]
fn a_link_a_gitfile_or_a_fifo_in_the_git_directory_is_refused_and_nothing_hangs() {
    let (dir, copy) = tracking_clone();
    let elsewhere = dir.path().join("elsewhere");
    std::fs::rename(copy.join(".git"), &elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, copy.join(".git")).unwrap();
    assert_eq!(status(&copy, "/root/app").unwrap_err().code, Some(DaemonErrorCode::NotAGitRepo));
    std::fs::remove_file(copy.join(".git")).unwrap();
    std::fs::write(copy.join(".git"), format!("gitdir: {}\n", elsewhere.display())).unwrap();
    assert_eq!(status(&copy, "/root/app").unwrap_err().code, Some(DaemonErrorCode::NotAGitRepo));
    std::fs::remove_file(copy.join(".git")).unwrap();
    std::fs::rename(&elsewhere, copy.join(".git")).unwrap();
    assert!(status(&copy, "/root/app").is_ok());

    let branch_ref = copy.join(".git/refs/heads/fix/cart");
    let secret = dir.path().join("secret");
    std::fs::copy(&branch_ref, &secret).unwrap();
    std::fs::remove_file(&branch_ref).unwrap();
    std::os::unix::fs::symlink(&secret, &branch_ref).unwrap();
    let err = status(&copy, "/root/app").unwrap_err();
    assert!(err.message.contains("a link stands at refs/heads/fix/cart"), "{}", err.message);
    std::fs::remove_file(&branch_ref).unwrap();

    // A packed ref that names no commit is damaged, never a branch with nothing on it.
    std::fs::write(copy.join(".git/packed-refs"), "# pack-refs with: peeled\nnot-an-oid refs/heads/fix/cart\n").unwrap();
    assert!(status(&copy, "/root/app").unwrap_err().message.contains("refs/heads/fix/cart holds no commit"));

    std::fs::write(copy.join(".git/HEAD"), "ref: refs/heads/../../../etc/passwd\n").unwrap();
    assert!(status(&copy, "/root/app").unwrap_err().message.contains("HEAD names no ref"));
    std::fs::remove_file(copy.join(".git/HEAD")).unwrap();
    let made = Command::new("mkfifo").arg(copy.join(".git/HEAD")).status().unwrap();
    assert!(made.success());
    assert!(status(&copy, "/root/app").unwrap_err().message.contains("HEAD is not a file"));
}

/// Everything a checkout's config and folder can name that runs a program, each writing a mark of its own: an
/// fsmonitor, a hooks folder and the hooks in .git/hooks, a filter's clean, smudge and process, a textconv, an
/// ssh command, a credential helper, a gpg program, a pager, an editor, an alias over status, and an include and
/// an includeIf naming a file that sets an fsmonitor of its own. The worktree is dirty, so a status that read it
/// would hand the change to the filter.
#[test]
fn a_hostile_config_runs_nothing_and_the_branch_still_reads() {
    let (dir, copy) = tracking_clone();
    let want = by_git(&copy);
    let marks = dir.path().join("marks");
    std::fs::create_dir(&marks).unwrap();
    let script = |name: &str| -> String {
        let at = dir.path().join(format!("run-{name}"));
        std::fs::write(&at, format!("#!/bin/sh\ntouch '{}/{name}'\nexit 1\n", marks.display())).unwrap();
        std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        at.to_string_lossy().into_owned()
    };
    let hooks = dir.path().join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    for hook in ["pre-commit", "post-checkout", "post-index-change", "reference-transaction", "fsmonitor-watchman", "pre-push"] {
        let body = format!("#!/bin/sh\ntouch '{}/hook-{hook}'\n", marks.display());
        for folder in [hooks.clone(), copy.join(".git/hooks")] {
            std::fs::write(folder.join(hook), &body).unwrap();
            std::fs::set_permissions(folder.join(hook), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        }
    }
    let included = dir.path().join("included");
    std::fs::write(&included, format!("[core]\n\tfsmonitor = {}\n", script("include"))).unwrap();
    let hostile = format!(
        "[core]\n\tfsmonitor = {fsmonitor}\n\thooksPath = {hooks}\n\tsshCommand = {ssh}\n\tpager = {pager}\n\teditor = {editor}\n\
         [filter \"evil\"]\n\tclean = {clean}\n\tsmudge = {smudge}\n\tprocess = {process}\n\trequired = true\n\
         [diff \"evil\"]\n\ttextconv = {textconv}\n\
         [credential]\n\thelper = !{credential}\n\
         [gpg]\n\tprogram = {gpg}\n\
         [alias]\n\tstatus = !{alias}\n\
         [include]\n\tpath = {included}\n\
         [includeIf \"gitdir:/\"]\n\tpath = {included}\n",
        fsmonitor = script("fsmonitor"),
        hooks = hooks.display(),
        ssh = script("ssh"),
        pager = script("pager"),
        editor = script("editor"),
        clean = script("clean"),
        smudge = script("smudge"),
        process = script("process"),
        textconv = script("textconv"),
        credential = script("credential"),
        gpg = script("gpg"),
        alias = script("alias"),
        included = included.display(),
    );
    let config = copy.join(".git/config");
    std::fs::write(&config, format!("{}{hostile}", std::fs::read_to_string(&config).unwrap())).unwrap();
    std::fs::write(copy.join(".gitattributes"), "* filter=evil diff=evil\n").unwrap();
    std::fs::write(copy.join("a.txt"), "an edit never committed\n").unwrap();
    std::fs::write(copy.join("untracked.txt"), "new\n").unwrap();

    let read = status(&copy, "/root/app").unwrap();
    assert_eq!(read.branch, want);
    assert!(read.entries.is_empty() && read.edits_unread);
    let ran: Vec<String> = std::fs::read_dir(&marks).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(ran.is_empty(), "the read ran {ran:?}");
}

/// One repo read by both roads, the running one through git and the stopped one off the files, answers one
/// branch: tracking, with no upstream, with an upstream whose tracking ref is gone, detached, and with no commits.
#[tokio::test]
async fn a_running_copy_and_a_stopped_one_answer_the_same_branch() {
    let both = async |copy: &Path| {
        let running = crate::git::git_status(&crate::git::here::Here::new(), copy).await.unwrap().branch;
        assert_eq!(running, status(copy, "/root/app").unwrap().branch);
        running
    };
    let (dir, copy) = tracking_clone();
    assert_eq!(both(&copy).await.upstream.as_deref(), Some("origin/main"));
    git(&copy, &["branch", "-q", "--unset-upstream"]);
    let unset = both(&copy).await;
    assert_eq!((unset.upstream, unset.ahead, unset.behind), (None, 2, 1));
    git(&copy, &["branch", "-q", "--set-upstream-to=origin/main"]);
    git(&copy, &["update-ref", "-d", "refs/remotes/origin/main"]);
    // origin/HEAD left naming a branch a prune took, as a renamed default branch leaves it: both fall to main.
    let dangling = both(&copy).await;
    assert_eq!((dangling.upstream, dangling.ahead, dangling.behind), (None, 2, 0));
    git(&copy, &["remote", "set-head", "origin", "-d"]);
    let gone = both(&copy).await;
    assert_eq!((gone.upstream, gone.ahead, gone.behind), (None, 2, 0));
    git(&copy, &["checkout", "-q", "--detach", "HEAD~1"]);
    assert_eq!(both(&copy).await.head, "(detached)");
    let empty = dir.path().join("empty");
    std::fs::create_dir(&empty).unwrap();
    git(&empty, &["init", "-q"]);
    assert_eq!(both(&empty).await.oid, "(initial)");
}

/// A pack whose one object is a delta over itself: the chain is followed in a loop and ends at the depth cap,
/// never on the stack of a daemon that aborts on overflow.
#[test]
fn a_delta_that_names_itself_as_its_base_ends_at_the_depth_cap() {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    let oid = vec![0x42u8; 20];
    let mut delta = Vec::new();
    flate2::write::ZlibEncoder::new(&mut delta, flate2::Compression::default()).write_all(&[0, 0]).unwrap();
    let mut pack = b"PACK\0\0\0\x02\0\0\0\x01".to_vec();
    pack.push(0x72);
    pack.extend_from_slice(&oid);
    pack.extend_from_slice(&delta);
    let mut idx = vec![0xff, b't', b'O', b'c', 0, 0, 0, 2];
    for byte in 0..=255u8 {
        idx.extend_from_slice(&u32::from(byte >= 0x42).to_be_bytes());
    }
    idx.extend_from_slice(&oid);
    idx.extend_from_slice(&[0; 4]);
    idx.extend_from_slice(&12u32.to_be_bytes());
    let packs = dir.path().join(".git/objects/pack");
    std::fs::write(packs.join("pack-self.pack"), pack).unwrap();
    std::fs::write(packs.join("pack-self.idx"), idx).unwrap();
    let git_dir = GitDir::open(dir.path()).unwrap();
    let err = Repo::new(&git_dir).unwrap().object(&oid).unwrap_err();
    assert!(err.contains("a delta chain is too deep"), "{err}");
}

/// One pack entry's header: its type and inflated size.
fn entry_head(kind: u8, size: usize) -> Vec<u8> {
    let mut head = vec![(kind << 4) | (size & 15) as u8];
    let mut rest = size >> 4;
    while rest > 0 {
        *head.last_mut().unwrap() |= 0x80;
        head.push((rest & 0x7f) as u8);
        rest >>= 7;
    }
    head
}

fn zlib(bytes: &[u8]) -> Vec<u8> {
    let mut out = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    out.write_all(bytes).unwrap();
    out.finish().unwrap()
}

fn size_varint(mut n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}

/// A delta over `base` that writes `head` of its own, then copies `base[from..]` whole.
fn delta_over(base: &[u8], head: &[u8], from: usize) -> Vec<u8> {
    let mut delta = size_varint(base.len());
    delta.extend(size_varint(head.len() + base.len() - from));
    for chunk in head.chunks(127) {
        delta.push(chunk.len() as u8);
        delta.extend_from_slice(chunk);
    }
    let len = base.len() - from;
    delta.push(0x80 | 0x0f | 0x70);
    delta.extend_from_slice(&(from as u32).to_le_bytes());
    delta.extend_from_slice(&(len as u32).to_le_bytes()[..3]);
    delta
}

/// A repository whose objects are one hand-built pack: a whole commit of `pad` bytes that nothing names, and
/// `commits` commits in a line, each a delta naming that commit as its base by id and copying its bytes, the
/// shape a history built to be slow takes. feature is the last of them and main the first.
fn slow_history(pad: usize, commits: u8) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    let base_oid = vec![0xf0u8; 20];
    let mut base = format!("tree {}\ncommitter t <t> 1 +0000\n\n", "0".repeat(40)).into_bytes();
    let from = base.len();
    base.resize(from + pad, b'x');
    let mut entries = vec![(base_oid.clone(), [entry_head(1, base.len()), zlib(&base)].concat())];
    for n in 1..=commits {
        let parent = if n == 1 { String::new() } else { format!("parent {}\n", hex(&[n - 1; 20])) };
        let head = format!("tree {}\n{parent}committer t <t> {n} +0000\n\n", "0".repeat(40));
        let delta = delta_over(&base, head.as_bytes(), from);
        entries.push((vec![n; 20], [entry_head(7, delta.len()), base_oid.clone(), zlib(&delta)].concat()));
    }
    entries.sort();
    let mut pack = b"PACK\0\0\0\x02".to_vec();
    pack.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    let mut offsets = Vec::new();
    for (_, bytes) in &entries {
        offsets.push(pack.len() as u32);
        pack.extend_from_slice(bytes);
    }
    let mut idx = vec![0xff, b't', b'O', b'c', 0, 0, 0, 2];
    for byte in 0..=255u8 {
        idx.extend_from_slice(&(entries.iter().filter(|(oid, _)| oid[0] <= byte).count() as u32).to_be_bytes());
    }
    entries.iter().for_each(|(oid, _)| idx.extend_from_slice(oid));
    idx.extend(vec![0u8; 4 * entries.len()]);
    offsets.iter().for_each(|at| idx.extend_from_slice(&at.to_be_bytes()));
    let packs = dir.path().join(".git/objects/pack");
    std::fs::write(packs.join("pack-slow.pack"), pack).unwrap();
    std::fs::write(packs.join("pack-slow.idx"), idx).unwrap();
    std::fs::write(dir.path().join(".git/refs/heads/feature"), format!("{}\n", hex(&[commits; 20]))).unwrap();
    std::fs::write(dir.path().join(".git/refs/heads/main"), format!("{}\n", hex(&[1; 20]))).unwrap();
    std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/feature\n").unwrap();
    dir
}

/// Commits are small, so a commit, or a base one is built on, past the object cap is refused before any of it
/// is inflated: a 72 KB pack of deltas over one huge base once cost a quarter second a commit.
#[test]
fn a_commit_built_on_a_base_past_the_object_cap_is_refused_at_once() {
    let fits = slow_history(64 << 10, 8);
    let read = status(fits.path(), "/root/app").unwrap();
    assert_eq!((read.branch.ahead, read.branch.behind, read.counts_unknown), (7, 0, false));
    let huge = slow_history(2 << 20, 8);
    let started = Instant::now();
    let err = status(huge.path(), "/root/app").unwrap_err();
    assert!(err.message.contains("past 1048576 bytes"), "{}", err.message);
    assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
}

/// A walk past what it may inflate or past its time answers its counts as unknown, never as a count and never
/// by holding the thread.
#[test]
fn a_walk_past_its_budget_answers_unknown_counts_rather_than_a_count() {
    let slow = slow_history(256 << 10, 32);
    let dir = GitDir::open(slow.path()).unwrap();
    let mut spent = Repo::new(&dir).unwrap();
    spent.budget = 2 << 20;
    let branch = spent.branch().unwrap();
    assert!(spent.over_budget);
    assert_eq!((branch.head.as_str(), branch.ahead, branch.behind), ("feature", 0, 0));
    let mut late = Repo::new(&dir).unwrap();
    late.deadline = Instant::now();
    late.branch().unwrap();
    assert!(late.over_budget);
    let mut whole = Repo::new(&dir).unwrap();
    assert_eq!(whole.branch().unwrap().ahead, 31);
    assert!(!whole.over_budget);
}

/// Each file has a cap of its own, and a config at its cap costs its bytes: the lines no query asked for are
/// dropped as they are read.
#[test]
fn a_file_past_its_cap_is_refused_and_a_config_keeps_only_what_is_asked() {
    let (_dir, copy) = tracking_clone();
    let config = copy.join(".git/config");
    let kept = std::fs::read_to_string(&config).unwrap();
    let junk = "b\n".repeat(((1 << 20) - kept.len()) / 2);
    assert!(parse_config(&junk, |_, _, _| false).is_empty());
    std::fs::write(&config, format!("{junk}{kept}")).unwrap();
    assert_eq!(status(&copy, "/root/app").unwrap().branch.upstream.as_deref(), Some("origin/main"));
    std::fs::write(&config, format!("{junk}{kept}{}", "b\n".repeat(64))).unwrap();
    assert!(status(&copy, "/root/app").unwrap_err().message.contains("config is too large"));
    std::fs::write(&config, kept).unwrap();
    std::fs::write(copy.join(".git/HEAD"), format!("ref: refs/heads/fix/cart\n{}", " ".repeat(16 << 10))).unwrap();
    assert!(status(&copy, "/root/app").unwrap_err().message.contains("HEAD is too large"));
    std::fs::write(copy.join(".git/HEAD"), "ref: refs/heads/fix/cart\n").unwrap();
    std::fs::write(copy.join(".git/config"), "[extensions]\n\trefStorage = reftable\n").unwrap();
    assert!(status(&copy, "/root/app").unwrap_err().message.contains("refs kept as reftable are not ones this reads"));
}

#[test]
fn config_reads_sections_subsections_quotes_comments_and_continued_lines() {
    let text = "# top\n[branch \"fix/Cart\"]\n\tremote = origin ; a comment\n\tmerge = \"refs/heads/ma\\\nin\"\n\
                [Remote \"origin\"]\n\tFetch = +refs/heads/*:refs/remotes/origin/*\n[core.Sub]\n\tbare\n";
    let config = Config(text.to_owned());
    assert_eq!(config.last("branch", Some("fix/Cart"), "remote").as_deref(), Some("origin"));
    assert_eq!(config.last("branch", Some("fix/Cart"), "merge").as_deref(), Some("refs/heads/main"));
    assert_eq!(config.last("branch", Some("fix/cart"), "merge"), None);
    assert_eq!(config.all("remote", Some("origin"), "fetch"), vec!["+refs/heads/*:refs/remotes/origin/*"]);
    assert_eq!(config.last("core", Some("sub"), "bare").as_deref(), Some("true"));
    let specs = |all: &[&str]| all.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        tracking_of(&specs(&["+refs/heads/*:refs/remotes/origin/*"]), "refs/heads/main").as_deref(),
        Some("refs/remotes/origin/main")
    );
    assert_eq!(tracking_of(&specs(&["refs/heads/main:refs/remotes/o/m"]), "refs/heads/main").as_deref(), Some("refs/remotes/o/m"));
    assert_eq!(tracking_of(&specs(&["^refs/heads/main", "refs/heads/dev:refs/x"]), "refs/heads/main"), None);
}

#[test]
fn a_ref_name_that_would_walk_out_of_the_git_directory_is_no_ref() {
    assert!(plain_ref("refs/heads/fix/cart"));
    for bad in ["refs/heads/../../x", "refs/heads/.hidden", "refs//x", "HEAD", "/etc/passwd", "refs/heads/a.lock", "refs/heads/a b"] {
        assert!(!plain_ref(bad), "{bad}");
    }
}

#[test]
fn a_delta_copies_and_inserts_and_a_damaged_one_is_refused() {
    let base = b"hello world";
    let delta = [11, 9, 0x91, 0, 5, 4, b' ', b'y', b'o', b'u'];
    assert_eq!(apply_delta(base, &delta).as_deref(), Some(&b"hello you"[..]));
    assert_eq!(apply_delta(base, &[10, 9]), None);
    assert_eq!(apply_delta(base, &[11, 5, 0x91, 8, 5]), None);
    assert_eq!(apply_delta(base, &[11, 1, 0]), None);
}
