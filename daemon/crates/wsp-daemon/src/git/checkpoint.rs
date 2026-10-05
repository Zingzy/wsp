// SPDX-License-Identifier: AGPL-3.0-only
//! A checkout's tree at a turn's end, recorded with plumbing alone into a temporary index, and put back on request.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use wsp_frames::{
    checkpoint_id_ok, checkpoint_prefix, DaemonErrorCode, GitCheckpointDropReply, GitCheckpointReply, GitRestoreReply, CHECKPOINT_REFS,
};

use super::{check, parse_name_status, run_git, stdout_text, GitResult, Runs};
use crate::paths::OpError;

/// Who a checkpoint's commit says wrote it: commit-tree refuses a repo with no identity set, and the person's own
/// name does not belong on a record wsp keeps.
const CHECKPOINT_IDENTITY: [&str; 4] =
    ["GIT_AUTHOR_NAME=wsp", "GIT_AUTHOR_EMAIL=wsp@localhost", "GIT_COMMITTER_NAME=wsp", "GIT_COMMITTER_EMAIL=wsp@localhost"];

/// How many checkpoint refs one thread keeps under its scope, the `-before-` refs a restore writes among them.
pub(crate) const REFS_PER_THREAD: usize = 100;

/// The checkout's whole tree under `refs/wsp/checkpoints/<scope>/<thread>/<turn>`, the scope the folder record's id
/// where the host names one, else the folder the checkout's top level sits in. The same tree under the same ref keeps
/// its commit, and the thread's oldest refs past the hundredth go.
pub(crate) async fn checkpoint<R: Runs>(
    runner: &R,
    cwd: &Path,
    scope: Option<&str>,
    thread: &str,
    turn: &str,
) -> Result<GitCheckpointReply, OpError> {
    for (what, id) in [("thread", thread), ("turn", turn)] {
        plain(what, id)?;
    }
    let top = top_of(runner, cwd).await?;
    let prefix = prefix_for(&top, scope)?;
    let name = format!("{prefix}{thread}/{turn}");
    let taken = record(runner, &top, &name).await?;
    if taken.changed {
        keep_newest(runner, &top, &format!("{prefix}{thread}/"), &[&name]).await?;
    }
    Ok(taken)
}

/// Every checkpoint ref of one thread under the scope taken away, and no other thread's.
pub(crate) async fn drop_thread<R: Runs>(
    runner: &R,
    cwd: &Path,
    scope: Option<&str>,
    thread: &str,
) -> Result<GitCheckpointDropReply, OpError> {
    plain("thread", thread)?;
    let top = top_of(runner, cwd).await?;
    let held = refs_under(runner, &top, &format!("{}{thread}/", prefix_for(&top, scope)?)).await?;
    delete_refs(runner, &top, &held).await?;
    Ok(GitCheckpointDropReply { dropped: held.len() as u64 })
}

fn plain(what: &str, id: &str) -> Result<(), OpError> {
    if checkpoint_id_ok(id) {
        return Ok(());
    }
    Err(OpError::coded(DaemonErrorCode::BadRequest, format!("a checkpoint's {what} must be one plain name, got {id:?}")))
}

/// The prefix a checkout's checkpoints sit under, with its closing slash: the scope's, else the folder's.
fn prefix_for(top: &Path, scope: Option<&str>) -> Result<String, OpError> {
    match scope {
        Some(scope) => {
            plain("scope", scope)?;
            Ok(format!("{CHECKPOINT_REFS}/{scope}/"))
        }
        None => Ok(prefix_at(top)),
    }
}

/// The refs under a prefix, oldest commit first.
async fn refs_under<R: Runs>(runner: &R, top: &Path, prefix: &str) -> Result<Vec<String>, OpError> {
    let listed =
        run_git(runner, top, &["for-each-ref", "--sort=creatordate", "--format=%(refname)", prefix.trim_end_matches('/')], None, None)
            .await?;
    ran(&listed, "for-each-ref")?;
    Ok(stdout_text(&listed).lines().filter(|name| name.starts_with(prefix)).map(str::to_owned).collect())
}

async fn delete_refs<R: Runs>(runner: &R, top: &Path, names: &[String]) -> Result<(), OpError> {
    if names.is_empty() {
        return Ok(());
    }
    let lines: String = names.iter().map(|name| format!("delete {name}\n")).collect();
    let deleted = run_git(runner, top, &["update-ref", "--stdin"], Some(lines.as_bytes()), None).await?;
    ran(&deleted, "update-ref")
}

/// The thread's refs past the newest hundred taken away, oldest first, never one of `keep`.
async fn keep_newest<R: Runs>(runner: &R, top: &Path, prefix: &str, keep: &[&str]) -> Result<(), OpError> {
    let held = refs_under(runner, top, prefix).await?;
    let over = held.len().saturating_sub(REFS_PER_THREAD);
    let gone: Vec<String> = held.into_iter().filter(|name| !keep.contains(&name.as_str())).take(over).collect();
    delete_refs(runner, top, &gone).await
}

/// The tree put back to a checkpoint of this folder's: the tree as it stands recorded first beside it, every file
/// that checkpoint lacks removed, and every file it holds written as it holds it.
pub(crate) async fn restore<R: Runs>(runner: &R, cwd: &Path, scope: Option<&str>, checkpoint: &str) -> Result<GitRestoreReply, OpError> {
    let top = top_of(runner, cwd).await?;
    let prefix = prefix_for(&top, scope)?;
    let named = checkpoint.strip_prefix(&prefix).is_some_and(|rest| rest.split('/').all(checkpoint_id_ok) && !rest.is_empty());
    if !named {
        return Err(OpError::coded(DaemonErrorCode::BadRequest, format!("{checkpoint:?} is not a checkpoint of this folder")));
    }
    let target = run_git(runner, &top, &["rev-parse", "--verify", "-q", &format!("{checkpoint}^{{commit}}")], None, None).await?;
    if target.code != Some(0) {
        return Err(OpError::plain(format!("no checkpoint {checkpoint} in this folder")));
    }
    let target = stdout_text(&target).trim().to_owned();
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let before = record(runner, &top, &format!("{checkpoint}-before-{millis}")).await?;
    let thread = checkpoint[prefix.len()..].split('/').next().unwrap_or_default();
    keep_newest(runner, &top, &format!("{prefix}{thread}/"), &[checkpoint, &before.checkpoint_ref]).await?;

    let changed = run_git(runner, &top, &["diff", "--name-status", "--no-renames", "-z", &target, &before.commit], None, None).await?;
    check(&changed, "diff --name-status")?;
    let text = stdout_text(&changed);
    let added: Vec<String> = text
        .split('\0')
        .collect::<Vec<_>>()
        .chunks(2)
        .filter(|p| p.first() == Some(&"A"))
        .filter_map(|p| p.get(1).map(|s| (*s).to_owned()))
        .collect();
    let files = parse_name_status(&text).len() as u64;
    if !added.is_empty() {
        let mut args = vec!["-f", "--"];
        args.extend(added.iter().map(String::as_str));
        let removed = runner.run(&top, "rm", &args, None, None).await?;
        ran(&removed, "rm")?;
    }
    let at = top.as_path();
    let target = target.as_str();
    with_index(runner, at, |index| async move {
        let read = git_on(runner, at, &index, &["read-tree", target]).await?;
        ran(&read, "read-tree")?;
        let out = git_on(runner, at, &index, &["checkout-index", "-a", "-f"]).await?;
        ran(&out, "checkout-index")
    })
    .await?;
    Ok(GitRestoreReply { before: before.checkpoint_ref, files })
}

/// The tree into a temporary index seeded from the checkout's own (so git hashes only what changed), then a
/// commit of it under the ref.
async fn record<R: Runs>(runner: &R, top: &Path, name: &str) -> Result<GitCheckpointReply, OpError> {
    let tree = with_index(runner, top, |index| async move {
        let added = git_on(runner, top, &index, &["add", "-A"]).await?;
        ran(&added, "add")?;
        let written = git_on(runner, top, &index, &["write-tree"]).await?;
        ran(&written, "write-tree")?;
        Ok(stdout_text(&written).trim().to_owned())
    })
    .await?;
    let held = run_git(runner, top, &["rev-parse", "--verify", "-q", &format!("{name}^{{commit}}")], None, None).await?;
    if held.code == Some(0) {
        let commit = stdout_text(&held).trim().to_owned();
        let tree_then = run_git(runner, top, &["rev-parse", &format!("{commit}^{{tree}}")], None, None).await?;
        if stdout_text(&tree_then).trim() == tree {
            return Ok(GitCheckpointReply { checkpoint_ref: name.to_owned(), commit, changed: false });
        }
    }
    let mut args: Vec<&str> = CHECKPOINT_IDENTITY.to_vec();
    args.extend(["git", "commit-tree", &tree, "-m", "wsp checkpoint"]);
    let committed = runner.run(top, "env", &args, None, None).await?;
    ran(&committed, "commit-tree")?;
    let commit = stdout_text(&committed).trim().to_owned();
    let moved = run_git(runner, top, &["update-ref", name, &commit], None, None).await?;
    ran(&moved, "update-ref")?;
    Ok(GitCheckpointReply { checkpoint_ref: name.to_owned(), commit, changed: true })
}

pub(super) async fn top_of<R: Runs>(runner: &R, cwd: &Path) -> Result<PathBuf, OpError> {
    let top = run_git(runner, cwd, &["rev-parse", "--show-toplevel"], None, None).await?;
    check(&top, "rev-parse")?;
    if top.code != Some(0) {
        return Err(super::not_a_repo());
    }
    Ok(PathBuf::from(stdout_text(&top).trim()))
}

fn prefix_at(top: &Path) -> String {
    checkpoint_prefix(&top.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// A temporary index beside the checkout's own, seeded from it, handed to the work and removed after whatever the
/// work came to. Named per call, so two turns ending in one copy at once do not share one.
pub(super) async fn with_index<R, F, Fut, T>(runner: &R, top: &Path, work: F) -> Result<T, OpError>
where
    R: Runs,
    F: FnOnce(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<T, OpError>>,
{
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let named = format!("wsp-checkpoint-{}-{nanos}.index", std::process::id());
    let index = git_path(runner, top, &named).await?;
    let own = git_path(runner, top, "index").await?;
    // A checkout with no index yet has nothing to seed from; add -A then hashes every file, which is slower and
    // the same tree. The copy keeps the index's time, since git re-hashes only the entries as new as the index file.
    let _ = runner.run(top, "cp", &["-pf", &own.to_string_lossy(), &index.to_string_lossy()], None, None).await?;
    let done = work(index.clone()).await;
    let _ = runner.run(top, "rm", &["-f", &index.to_string_lossy()], None, None).await;
    done
}

pub(super) async fn git_path<R: Runs>(runner: &R, top: &Path, name: &str) -> Result<PathBuf, OpError> {
    let at = run_git(runner, top, &["rev-parse", "--git-path", name], None, None).await?;
    ran(&at, "rev-parse --git-path")?;
    Ok(top.join(stdout_text(&at).trim()))
}

/// git with its index at that path: the variable is the only way git takes one, so the program is env. The
/// fsmonitor is off, since a checkout's config is the agent's to write and that setting names a program git starts.
pub(super) async fn git_on<R: Runs>(runner: &R, top: &Path, index: &Path, args: &[&str]) -> Result<GitResult, OpError> {
    let variable = format!("GIT_INDEX_FILE={}", index.to_string_lossy());
    let mut all = vec![variable.as_str(), "git", "-c", "core.fsmonitor=false"];
    all.extend_from_slice(args);
    runner.run(top, "env", &all, None, None).await
}

/// Exit 0 alone is success for the plumbing here; unlike a diff, a 1 is a failure.
pub(super) fn ran(res: &GitResult, what: &str) -> Result<(), OpError> {
    if res.code == Some(0) {
        return Ok(());
    }
    check(res, what)?;
    Err(OpError::plain(format!("git {what} failed: {}", res.stderr.trim())))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use wsp_frames::DaemonErrorCode;

    use super::*;
    use crate::git::here::Here;

    fn git(at: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(at).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// A repo in a folder named like a copy: two tracked files, an ignore rule, an ignored folder with a file in it.
    fn copy() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let at = dir.path().join("spoo-fix-login");
        fs::create_dir_all(at.join("src")).unwrap();
        git(&at, &["init", "-q", "-b", "main"]);
        fs::write(at.join(".gitignore"), "node_modules/\n").unwrap();
        fs::write(at.join("one.txt"), "one\n").unwrap();
        fs::write(at.join("src/keep.txt"), "keep\n").unwrap();
        git(&at, &["add", "-A"]);
        git(&at, &["commit", "-q", "-m", "start"]);
        fs::create_dir_all(at.join("node_modules/pkg")).unwrap();
        fs::write(at.join("node_modules/pkg/index.js"), "ignored\n").unwrap();
        (dir, at)
    }

    fn tree_of(at: &Path, rev: &str) -> String {
        git(at, &["rev-parse", &format!("{rev}^{{tree}}")])
    }

    #[tokio::test]
    async fn a_checkpoint_records_the_whole_tree_under_the_copys_ref_and_moves_nothing_else() {
        let (_dir, at) = copy();
        fs::write(at.join("one.txt"), "uno\n").unwrap();
        fs::write(at.join("new.txt"), "untracked\n").unwrap();
        let (head, index) = (git(&at, &["rev-parse", "HEAD"]), git(&at, &["write-tree"]));
        let taken = checkpoint(&Here::new(), &at.join("src"), None, "thr_1", "turn_1").await.unwrap();
        assert_eq!(taken.checkpoint_ref, "refs/wsp/checkpoints/spoo-fix-login/thr_1/turn_1");
        assert!(taken.changed);
        assert_eq!(git(&at, &["rev-parse", &taken.checkpoint_ref]), taken.commit);
        let listed = git(&at, &["ls-tree", "-r", "--name-only", &taken.commit]);
        let files: Vec<&str> = listed.lines().collect();
        assert_eq!(files, [".gitignore", "new.txt", "one.txt", "src/keep.txt"], "untracked in, ignored out");
        assert_eq!(git(&at, &["show", &format!("{}:one.txt", taken.commit)]), "uno");
        // HEAD, the branch and the index are as they were, and no branch view lists the checkpoint.
        assert_eq!(git(&at, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&at, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert_eq!(git(&at, &["write-tree"]), index);
        assert!(!git(&at, &["log", "--branches", "--format=%H"]).contains(&taken.commit));
        assert_eq!(git(&at, &["diff", "--cached", "--name-only"]), "", "nothing is staged");
        assert_eq!(git(&at, &["status", "--porcelain"]), "M one.txt\n?? new.txt");
    }

    #[tokio::test]
    async fn a_checkpoint_starts_no_fsmonitor_the_checkouts_config_names() {
        // The checkout's config is the agent's to write, and core.fsmonitor names a program git starts on add.
        let (dir, at) = copy();
        let ran = dir.path().join("fsmonitor-ran");
        let hook = dir.path().join("fsmonitor.sh");
        fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", ran.display())).unwrap();
        fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        git(&at, &["config", "core.fsmonitor", &hook.to_string_lossy()]);
        fs::write(at.join("one.txt"), "uno\n").unwrap();
        checkpoint(&Here::new(), &at, None, "thr_1", "turn_1").await.unwrap();
        assert!(!ran.exists(), "the checkpoint started the checkout's fsmonitor");
    }

    #[tokio::test]
    async fn a_snapshot_from_a_subfolder_takes_the_whole_checkout_on_top_of_head_and_starts_no_fsmonitor() {
        let (dir, at) = copy();
        let ran = dir.path().join("fsmonitor-ran");
        let hook = dir.path().join("fsmonitor.sh");
        fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", ran.display())).unwrap();
        fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        git(&at, &["config", "core.fsmonitor", &hook.to_string_lossy()]);
        fs::write(at.join("one.txt"), "uno\n").unwrap();
        fs::write(at.join("new.txt"), "untracked\n").unwrap();
        let index = fs::read(at.join(".git/index")).unwrap();
        let taken = crate::git::git_snapshot(&Here::new(), &at.join("src")).await.unwrap();
        assert!(!ran.exists(), "the snapshot started the checkout's fsmonitor");
        assert_eq!(git(&at, &["rev-parse", &format!("{}^", taken.commit)]), git(&at, &["rev-parse", "HEAD"]));
        let listed = git(&at, &["ls-tree", "-r", "--name-only", &taken.commit]);
        assert_eq!(listed.lines().collect::<Vec<_>>(), [".gitignore", "new.txt", "one.txt", "src/keep.txt"]);
        assert_eq!(fs::read(at.join(".git/index")).unwrap(), index, "the checkout's own index moved");
        let left: Vec<_> = fs::read_dir(at.join(".git"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".index"))
            .collect();
        assert!(left.is_empty(), "a temporary index stayed behind");
    }

    #[tokio::test]
    async fn the_same_tree_under_the_same_ref_is_the_same_checkpoint_and_an_edit_is_a_new_one() {
        let (_dir, at) = copy();
        let first = checkpoint(&Here::new(), &at, None, "thr_1", "turn_1").await.unwrap();
        let again = checkpoint(&Here::new(), &at, None, "thr_1", "turn_1").await.unwrap();
        assert_eq!((again.commit.as_str(), again.changed), (first.commit.as_str(), false));
        fs::write(at.join("one.txt"), "edited\n").unwrap();
        let edited = checkpoint(&Here::new(), &at, None, "thr_1", "turn_1").await.unwrap();
        assert!(edited.changed);
        assert_ne!(edited.commit, first.commit);
    }

    #[tokio::test]
    async fn a_restore_puts_the_tree_back_exactly_and_its_before_puts_it_back_again() {
        let (_dir, at) = copy();
        let kept = checkpoint(&Here::new(), &at, None, "thr_1", "turn_1").await.unwrap();
        // What came after: a tracked file edited, one deleted, one untracked file added, and by hand the ignored one.
        fs::write(at.join("one.txt"), "uno\n").unwrap();
        fs::remove_file(at.join("src/keep.txt")).unwrap();
        fs::write(at.join("two.txt"), "two\n").unwrap();
        fs::write(at.join("node_modules/pkg/index.js"), "rebuilt\n").unwrap();
        let head = git(&at, &["rev-parse", "HEAD"]);

        let restored = restore(&Here::new(), &at, None, &kept.checkpoint_ref).await.unwrap();
        assert_eq!(restored.files, 3);
        assert_eq!(fs::read_to_string(at.join("one.txt")).unwrap(), "one\n");
        assert_eq!(fs::read_to_string(at.join("src/keep.txt")).unwrap(), "keep\n");
        assert!(!at.join("two.txt").exists(), "a file added after the checkpoint goes");
        assert_eq!(
            fs::read_to_string(at.join("node_modules/pkg/index.js")).unwrap(),
            "rebuilt\n",
            "ignored files are not the checkpoint's"
        );
        let now = checkpoint(&Here::new(), &at, None, "thr_1", "check").await.unwrap();
        assert_eq!(tree_of(&at, &now.commit), tree_of(&at, &kept.commit), "the tree is the checkpoint's to the byte");
        assert_eq!(git(&at, &["rev-parse", "HEAD"]), head);

        // The tree as it stood before the restore is a checkpoint of its own, so nothing the restore took is lost.
        assert!(restored.before.starts_with("refs/wsp/checkpoints/spoo-fix-login/thr_1/turn_1-before-"), "{}", restored.before);
        restore(&Here::new(), &at, None, &restored.before).await.unwrap();
        assert_eq!(fs::read_to_string(at.join("one.txt")).unwrap(), "uno\n");
        assert_eq!(fs::read_to_string(at.join("two.txt")).unwrap(), "two\n");
        assert!(!at.join("src/keep.txt").exists());
    }

    /// Seconds since the epoch a file was last written.
    fn written(path: &Path) -> u64 {
        fs::metadata(path).unwrap().modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    #[tokio::test]
    async fn a_checkpoint_sees_an_edit_at_the_same_size_in_the_same_second_as_the_last_index_write() {
        // Git re-hashes an entry as new as the index file, since a stat check cannot tell a same-size edit in that
        // second apart; the seeded copy keeps the index's time, so a checkpoint in a later second hashes it too.
        let (_dir, at) = loop {
            let (dir, at) = copy();
            fs::write(at.join("one.txt"), "uno\n").unwrap();
            if written(&at.join("one.txt")) == written(&at.join(".git/index")) {
                break (dir, at);
            }
        };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        tokio::time::sleep(std::time::Duration::from_nanos(u64::from(1_000_000_000 - now.subsec_nanos()) + 20_000_000)).await;
        let taken = checkpoint(&Here::new(), &at, None, "thr_1", "turn_1").await.unwrap();
        assert_eq!(git(&at, &["show", &format!("{}:one.txt", taken.commit)]), "uno");
    }

    #[tokio::test]
    async fn a_restore_takes_only_a_checkpoint_of_this_copy() {
        let (_dir, at) = copy();
        let branch = git(&at, &["rev-parse", "HEAD"]);
        for bad in [
            "refs/heads/main",
            "refs/wsp/checkpoints/other-copy/thr_1/turn_1",
            "refs/wsp/checkpoints/spoo-fix-login/../../heads/main",
            "HEAD",
            "main",
        ] {
            let refused = restore(&Here::new(), &at, None, bad).await.err().unwrap_or_else(|| panic!("{bad} was taken"));
            assert_eq!(refused.code, Some(DaemonErrorCode::BadRequest), "{bad}: {}", refused.message);
        }
        let missing = restore(&Here::new(), &at, None, "refs/wsp/checkpoints/spoo-fix-login/thr_1/nope").await.err().unwrap();
        assert!(missing.message.contains("no checkpoint"), "{}", missing.message);
        assert_eq!(git(&at, &["rev-parse", "HEAD"]), branch);
    }

    fn refs(at: &Path, prefix: &str) -> Vec<String> {
        let listed = git(at, &["for-each-ref", "--format=%(refname)", prefix]);
        listed.lines().map(str::to_owned).collect()
    }

    #[tokio::test]
    async fn a_scope_names_the_refs_and_a_restore_takes_only_a_checkpoint_under_its_own_scope() {
        let (_dir, at) = copy();
        let taken = checkpoint(&Here::new(), &at, Some("ws_folder1"), "thr_1", "turn_1").await.unwrap();
        assert_eq!(taken.checkpoint_ref, "refs/wsp/checkpoints/ws_folder1/thr_1/turn_1");
        let other = checkpoint(&Here::new(), &at, None, "thr_1", "turn_1").await.unwrap();
        for (scope, bad) in [(Some("ws_folder1"), other.checkpoint_ref.as_str()), (None, taken.checkpoint_ref.as_str())] {
            let refused = restore(&Here::new(), &at, scope, bad).await.err().unwrap_or_else(|| panic!("{bad} was taken"));
            assert_eq!(refused.code, Some(DaemonErrorCode::BadRequest), "{bad}");
        }
        fs::write(at.join("one.txt"), "edited\n").unwrap();
        let restored = restore(&Here::new(), &at, Some("ws_folder1"), &taken.checkpoint_ref).await.unwrap();
        assert!(restored.before.starts_with("refs/wsp/checkpoints/ws_folder1/thr_1/turn_1-before-"), "{}", restored.before);
        assert_eq!(fs::read_to_string(at.join("one.txt")).unwrap(), "one\n");
        for scope in ["a/b", "..", ""] {
            let refused = checkpoint(&Here::new(), &at, Some(scope), "thr_1", "turn_1").await.err().unwrap();
            assert_eq!(refused.code, Some(DaemonErrorCode::BadRequest), "{scope}");
        }
    }

    /// A hundred refs of one thread already held, each its own commit a minute older than the next, five of them the
    /// `-before-` refs a restore writes, beside one ref of another thread older than them all.
    fn held_hundred(at: &Path) -> Vec<String> {
        let tree = tree_of(at, "HEAD");
        let mut names = Vec::new();
        let mut lines = String::new();
        for n in 0..=100u64 {
            let (thread, turn) = if n == 0 {
                ("thr_2", "turn_0".to_owned())
            } else if n % 20 == 0 {
                ("thr_1", format!("turn_{n}-before-{n}"))
            } else {
                ("thr_1", format!("turn_{n}"))
            };
            let out = Command::new("git")
                .args(["commit-tree", &tree, "-m", "old"])
                .env("GIT_COMMITTER_DATE", format!("{} +0000", 1_000_000_000 + n * 60))
                .env("GIT_AUTHOR_DATE", format!("{} +0000", 1_000_000_000 + n * 60))
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .current_dir(at)
                .output()
                .unwrap();
            let name = format!("refs/wsp/checkpoints/ws_1/{thread}/{turn}");
            lines.push_str(&format!("create {name} {}\n", String::from_utf8_lossy(&out.stdout).trim()));
            names.push(name);
        }
        let mut fed =
            Command::new("git").args(["update-ref", "--stdin"]).current_dir(at).stdin(std::process::Stdio::piped()).spawn().unwrap();
        std::io::Write::write_all(fed.stdin.as_mut().unwrap(), lines.as_bytes()).unwrap();
        assert!(fed.wait().unwrap().success());
        names
    }

    #[tokio::test]
    async fn a_thread_keeps_its_newest_hundred_refs_with_the_before_refs_counted_and_no_other_threads_go() {
        let (_dir, at) = copy();
        let names = held_hundred(&at);
        assert_eq!(refs(&at, "refs/wsp/checkpoints/ws_1/thr_1").len(), 100);
        fs::write(at.join("one.txt"), "turn 101\n").unwrap();
        let taken = checkpoint(&Here::new(), &at, Some("ws_1"), "thr_1", "turn_101").await.unwrap();
        let held = refs(&at, "refs/wsp/checkpoints/ws_1/thr_1");
        assert_eq!(held.len(), 100, "the 101st ref did not drop the oldest");
        assert!(!held.contains(&names[1]), "the oldest ref stayed");
        assert!(held.contains(&names[2]) && held.contains(&taken.checkpoint_ref));
        assert!(held.contains(&names[20]), "a before ref is a ref like any other and only the oldest goes");
        assert_eq!(refs(&at, "refs/wsp/checkpoints/ws_1/thr_2"), [names[0].clone()], "another thread's ref went");
        // A restore's own before ref counts too, and neither it nor the ref restored to is the one that goes, even
        // where that ref is the oldest the thread holds.
        let restored = restore(&Here::new(), &at, Some("ws_1"), &names[2]).await.unwrap();
        let held = refs(&at, "refs/wsp/checkpoints/ws_1/thr_1");
        assert_eq!(held.len(), 100);
        assert!(held.contains(&names[2]) && held.contains(&restored.before));
        assert!(!held.contains(&names[3]), "the oldest ref past the two kept stayed");
    }

    #[tokio::test]
    async fn dropping_a_threads_checkpoints_takes_its_refs_and_leaves_every_other_threads_and_scopes() {
        let (_dir, at) = copy();
        checkpoint(&Here::new(), &at, Some("ws_1"), "thr_1", "turn_1").await.unwrap();
        fs::write(at.join("one.txt"), "edited\n").unwrap();
        let before = restore(&Here::new(), &at, Some("ws_1"), "refs/wsp/checkpoints/ws_1/thr_1/turn_1").await.unwrap().before;
        assert!(before.contains("/thr_1/"));
        checkpoint(&Here::new(), &at, Some("ws_1"), "thr_10", "turn_1").await.unwrap();
        checkpoint(&Here::new(), &at, Some("ws_2"), "thr_1", "turn_1").await.unwrap();
        let dropped = drop_thread(&Here::new(), &at, Some("ws_1"), "thr_1").await.unwrap();
        assert_eq!(dropped, GitCheckpointDropReply { dropped: 2 });
        assert_eq!(
            refs(&at, "refs/wsp/checkpoints"),
            ["refs/wsp/checkpoints/ws_1/thr_10/turn_1", "refs/wsp/checkpoints/ws_2/thr_1/turn_1"]
        );
        assert_eq!(drop_thread(&Here::new(), &at, Some("ws_1"), "thr_1").await.unwrap().dropped, 0);
        assert_eq!(drop_thread(&Here::new(), &at, Some("ws_1"), "thr/1").await.err().unwrap().code, Some(DaemonErrorCode::BadRequest));
    }

    #[tokio::test]
    async fn a_checkpoint_refuses_an_id_that_is_not_one_plain_component_and_a_folder_that_is_not_a_repo() {
        let (_dir, at) = copy();
        for (thread, turn) in [("thr/1", "t"), ("thr_1", "../x"), ("", "t")] {
            let refused = checkpoint(&Here::new(), &at, None, thread, turn).await.err().unwrap();
            assert_eq!(refused.code, Some(DaemonErrorCode::BadRequest), "{thread} {turn}");
        }
        let plain = tempfile::tempdir().unwrap();
        let refused = checkpoint(&Here::new(), plain.path(), None, "thr_1", "turn_1").await.err().unwrap();
        assert_eq!(refused.code, Some(DaemonErrorCode::NotAGitRepo));
    }
}
