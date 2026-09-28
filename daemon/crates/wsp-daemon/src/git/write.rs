// SPDX-License-Identifier: AGPL-3.0-only
//! Every git write a pane or a verb asks of a copy: argv alone through the way of running the frame took, each file
//! named as a `:(top,literal)` pathspec so a `*` in a name is a letter, a message on stdin and never in argv, and one
//! wait for an index another git in the copy holds.

use std::path::Path;
use std::time::Duration;

use wsp_frames::{words, GitCommitReply, GitDiscardReply, GitStatusEntry};

use super::{check, parse_porcelain_v2, run_git, stdout_text, GitResult, Runs};
use crate::paths::OpError;

/// How long a write waits, once, for another git in the same copy to let go of its index.
const LOCK_WAIT: Duration = Duration::from_secs(1);

fn literal(path: &str) -> String {
    format!(":(top,literal){path}")
}

/// The copy's own name for a sentence: its top folder's.
fn named(top: &str) -> &str {
    Path::new(top).file_name().and_then(|n| n.to_str()).unwrap_or(top)
}

/// Why git refused a write, as one sentence: a held index, a copy with no author, or git's own last line, which is a
/// hook's when a hook said no.
pub(crate) fn refusal_of(res: &GitResult, copy: &str) -> OpError {
    if res.stderr.contains("index.lock") {
        return OpError::plain(words::COPY_BUSY);
    }
    if res.stderr.contains("Author identity unknown") || res.stderr.contains("empty ident name") {
        return OpError::plain(words::no_git_identity(copy));
    }
    let out = stdout_text(res);
    let said = [res.stderr.as_str(), out.as_str()]
        .into_iter()
        .flat_map(|text| text.lines().rev())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("git gave no reason");
    OpError::plain(words::commit_refused(said))
}

/// One git write, run again once after a wait where another git held the index.
async fn write<R: Runs>(runner: &R, cwd: &Path, args: &[&str], input: Option<&[u8]>, copy: &str) -> Result<GitResult, OpError> {
    let mut res = run_git(runner, cwd, args, input, None).await?;
    if res.code != Some(0) && res.stderr.contains("index.lock") {
        tokio::time::sleep(LOCK_WAIT).await;
        res = run_git(runner, cwd, args, input, None).await?;
    }
    if res.code != Some(0) {
        return Err(refusal_of(&res, copy));
    }
    Ok(res)
}

/// The checkout's top and every change in it, each untracked file on its own: status alone folds an untracked
/// folder into one entry, and a pane names the files inside it.
async fn changes<R: Runs>(runner: &R, cwd: &Path) -> Result<(String, Vec<GitStatusEntry>), OpError> {
    let res = run_git(runner, cwd, &["status", "--porcelain=v2", "-z", "--untracked-files=all"], None, None).await?;
    check(&res, "status")?;
    let top = run_git(runner, cwd, &["rev-parse", "--show-toplevel"], None, None).await?;
    check(&top, "rev-parse")?;
    Ok((stdout_text(&top).trim().to_owned(), parse_porcelain_v2(&stdout_text(&res)).1))
}

fn entry_of<'a>(entries: &'a [GitStatusEntry], path: &str) -> Option<&'a GitStatusEntry> {
    entries.iter().find(|e| e.xy != "!!" && e.path == path)
}

/// Puts one file back as HEAD has it. An untracked file goes; a rename takes its new name away and brings
/// the old one back; anything else, a file only staged as new included, is restored from HEAD in the index and the
/// worktree together.
pub(crate) async fn discard<R: Runs>(runner: &R, cwd: &Path, path: &str) -> Result<GitDiscardReply, OpError> {
    let (root, entries) = changes(runner, cwd).await?;
    let copy = named(&root).to_owned();
    let top = Path::new(&root);
    let Some(entry) = entry_of(&entries, path) else { return Err(OpError::plain(words::no_change(path))) };
    let spec = literal(path);
    if entry.xy == "??" {
        write(runner, top, &["clean", "-f", "--", &spec], None, &copy).await?;
    } else if let Some(orig) = &entry.orig_path {
        write(runner, top, &["restore", "--staged", "--", &spec], None, &copy).await?;
        write(runner, top, &["clean", "-f", "--", &spec], None, &copy).await?;
        write(runner, top, &["restore", "--source=HEAD", "--staged", "--worktree", "--", &literal(orig)], None, &copy).await?;
    } else {
        write(runner, top, &["restore", "--source=HEAD", "--staged", "--worktree", "--", &spec], None, &copy).await?;
    }
    // A file no commit has may leave the folders made for it empty, which git never sees and the Files pane does.
    if entry.xy == "??" || entry.xy.starts_with('A') || entry.orig_path.is_some() {
        drop_emptied(runner, top, path).await;
    }
    Ok(GitDiscardReply { path: path.to_owned() })
}

/// Removes each folder above a discarded file that it left empty, deepest first, through the same way git ran so a
/// copy inside a workspace is the disk touched. rmdir refuses a folder that holds anything, which is where it stops.
async fn drop_emptied<R: Runs>(runner: &R, top: &Path, path: &str) {
    for folder in Path::new(path).ancestors().skip(1).filter(|p| !p.as_os_str().is_empty()) {
        let Some(folder) = folder.to_str() else { return };
        match runner.run(top, "rmdir", &["--", folder], None, None).await {
            Ok(res) if res.code == Some(0) => {}
            _ => return,
        }
    }
}

/// Commits the named files and no others. An untracked one is added first; a rename takes its old name with it, so
/// the commit holds the move rather than a new file beside a deleted one. Hooks run where the copy's own code runs.
pub(crate) async fn commit<R: Runs>(runner: &R, cwd: &Path, message: &str, paths: &[String]) -> Result<GitCommitReply, OpError> {
    if paths.is_empty() {
        return Err(OpError::plain(words::NOTHING_TO_COMMIT));
    }
    let (root, entries) = changes(runner, cwd).await?;
    let copy = named(&root).to_owned();
    let top = Path::new(&root);
    let mut specs = Vec::new();
    for path in paths {
        let Some(entry) = entry_of(&entries, path) else { return Err(OpError::plain(words::no_change(path))) };
        if entry.xy == "??" {
            write(runner, top, &["add", "--", &literal(path)], None, &copy).await?;
        }
        specs.extend(entry.orig_path.iter().map(|orig| literal(orig)));
        specs.push(literal(path));
    }
    let mut args = vec!["commit", "-q", "-F", "-", "--"];
    args.extend(specs.iter().map(String::as_str));
    write(runner, top, &args, Some(message.as_bytes()), &copy).await?;
    let head = write(runner, top, &["log", "-1", "--format=%H%x00%s"], None, &copy).await?;
    let head = stdout_text(&head);
    let (oid, subject) = head.trim_end_matches('\n').split_once('\0').unwrap_or((head.trim(), ""));
    let stat = write(runner, top, &["show", "--shortstat", "--format=", "HEAD"], None, &copy).await?;
    let (files_changed, insertions, deletions) = shortstat(&stdout_text(&stat));
    Ok(GitCommitReply { oid: oid.to_owned(), subject: subject.to_owned(), files_changed, insertions, deletions })
}

/// ` 3 files changed, 10 insertions(+), 2 deletions(-)`, any part of which git leaves out when it is zero.
fn shortstat(text: &str) -> (u64, u64, u64) {
    let mut counts = (0, 0, 0);
    for part in text.trim().split(',') {
        let mut words = part.split_whitespace();
        let (Some(n), Some(what)) = (words.next().and_then(|n| n.parse().ok()), words.next()) else { continue };
        if what.starts_with("file") {
            counts.0 = n;
        } else if what.starts_with("insertion") {
            counts.1 = n;
        } else if what.starts_with("deletion") {
            counts.2 = n;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::here::Here;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Instant;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@x")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@x")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    /// A checkout on main whose one commit holds the files named, each holding its own name.
    struct Repo {
        dir: tempfile::TempDir,
    }

    impl Repo {
        fn with(files: &[&str]) -> Repo {
            let dir = tempfile::Builder::new().prefix("wsp-write-").tempdir().unwrap();
            let repo = Repo { dir };
            git(&repo.at(), &["init", "-q", "-b", "main"]);
            git(&repo.at(), &["config", "commit.gpgsign", "false"]);
            git(&repo.at(), &["config", "user.name", "t"]);
            git(&repo.at(), &["config", "user.email", "t@x"]);
            for file in files {
                repo.put(file, file);
            }
            git(&repo.at(), &["add", "-A"]);
            git(&repo.at(), &["commit", "-q", "-m", "first"]);
            repo
        }

        fn at(&self) -> PathBuf {
            self.dir.path().to_path_buf()
        }

        fn put(&self, name: &str, text: &str) {
            let file = self.at().join(name);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, format!("{text}\n")).unwrap();
        }

        fn read(&self, name: &str) -> Option<String> {
            std::fs::read_to_string(self.at().join(name)).ok()
        }

        fn short(&self) -> String {
            git(&self.at(), &["status", "--short", "--untracked-files=all"])
        }
    }

    fn named_paths(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| (*p).to_owned()).collect()
    }

    #[tokio::test]
    async fn a_commit_takes_a_modified_a_deleted_a_renamed_and_an_untracked_file_and_leaves_an_unnamed_one() {
        let repo = Repo::with(&["mod.txt", "gone.txt", "old.txt", "left.txt"]);
        repo.put("mod.txt", "changed");
        std::fs::remove_file(repo.at().join("gone.txt")).unwrap();
        git(&repo.at(), &["mv", "old.txt", "new.txt"]);
        repo.put("fresh.txt", "fresh");
        repo.put("sub/deep.txt", "deep");
        repo.put("left.txt", "not named");
        let message = "Say \"hi\" to the cart\n\nThe total rounds once now.\nSecond line.\n";
        let named = named_paths(&["mod.txt", "gone.txt", "new.txt", "fresh.txt", "sub/deep.txt"]);
        let done = commit(&Here::new(), &repo.at(), message, &named).await.unwrap();
        assert_eq!(git(&repo.at(), &["log", "-1", "--format=%B"]), format!("{message}\n"));
        assert_eq!(repo.short(), " M left.txt\n");
        assert_eq!(done.oid, git(&repo.at(), &["rev-parse", "HEAD"]).trim());
        assert_eq!(done.subject, "Say \"hi\" to the cart");
        assert_eq!(done.files_changed, 5);
        assert_eq!((done.insertions, done.deletions), (3, 2));
        let moved = git(&repo.at(), &["show", "--name-status", "--format=", "-M", "HEAD"]);
        assert!(moved.contains("R100\told.txt\tnew.txt"), "{moved}");
    }

    #[tokio::test]
    async fn a_star_in_a_name_is_a_letter_to_commit_and_to_discard() {
        let repo = Repo::with(&["a*b.txt", "aXb.txt"]);
        repo.put("a*b.txt", "star");
        repo.put("aXb.txt", "x");
        commit(&Here::new(), &repo.at(), "star\n", &named_paths(&["a*b.txt"])).await.unwrap();
        assert_eq!(repo.short(), " M aXb.txt\n");
        repo.put("a*b.txt", "again");
        discard(&Here::new(), &repo.at(), "a*b.txt").await.unwrap();
        assert_eq!(repo.short(), " M aXb.txt\n");
        assert_eq!(repo.read("aXb.txt").as_deref(), Some("x\n"));
    }

    #[tokio::test]
    async fn a_held_index_waits_once_then_says_the_copy_is_busy() {
        let repo = Repo::with(&["a.txt"]);
        repo.put("a.txt", "changed");
        std::fs::write(repo.at().join(".git/index.lock"), "").unwrap();
        let started = Instant::now();
        let err = commit(&Here::new(), &repo.at(), "m\n", &named_paths(&["a.txt"])).await.unwrap_err();
        assert_eq!(err.message, words::COPY_BUSY);
        assert!(started.elapsed() >= LOCK_WAIT, "{:?}", started.elapsed());
        std::fs::remove_file(repo.at().join(".git/index.lock")).unwrap();
        assert_eq!(repo.short(), " M a.txt\n");
    }

    #[tokio::test]
    async fn a_hook_that_says_no_is_the_refusal_in_its_own_last_line() {
        let repo = Repo::with(&["a.txt"]);
        let hook = repo.at().join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho checking >&2\necho 'lint failed: a.txt' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        repo.put("a.txt", "changed");
        let err = commit(&Here::new(), &repo.at(), "m\n", &named_paths(&["a.txt"])).await.unwrap_err();
        assert_eq!(err.message, words::commit_refused("lint failed: a.txt"));
    }

    #[tokio::test]
    async fn a_commit_naming_nothing_or_an_unchanged_file_is_refused_and_commits_nothing() {
        let repo = Repo::with(&["a.txt", "same.txt"]);
        repo.put("a.txt", "changed");
        let head = git(&repo.at(), &["rev-parse", "HEAD"]);
        assert_eq!(commit(&Here::new(), &repo.at(), "m\n", &[]).await.unwrap_err().message, words::NOTHING_TO_COMMIT);
        let err = commit(&Here::new(), &repo.at(), "m\n", &named_paths(&["a.txt", "same.txt"])).await.unwrap_err();
        assert_eq!(err.message, words::no_change("same.txt"));
        assert_eq!(git(&repo.at(), &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn git_knowing_no_author_is_the_sentence_that_names_the_fix() {
        let said = |stderr: &str| GitResult { code: Some(128), stdout: Vec::new(), stderr: stderr.to_owned(), truncated: false };
        let unknown = said("\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email\n\nfatal: unable to auto-detect email address\nAuthor identity unknown\n");
        assert_eq!(refusal_of(&unknown, "spoo-fix").message, words::no_git_identity("spoo-fix"));
        let locked = said("fatal: Unable to create '/w/.git/index.lock': File exists.\n");
        assert_eq!(refusal_of(&locked, "spoo-fix").message, words::COPY_BUSY);
    }

    #[test]
    fn shortstat_reads_each_count_and_a_zero_git_left_out() {
        assert_eq!(shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n"), (3, 10, 2));
        assert_eq!(shortstat(" 1 file changed, 1 insertion(+)\n"), (1, 1, 0));
        assert_eq!(shortstat(" 1 file changed, 4 deletions(-)\n"), (1, 0, 4));
        assert_eq!(shortstat(""), (0, 0, 0));
    }

    #[tokio::test]
    async fn a_discard_puts_back_a_modified_a_deleted_and_a_renamed_file_and_removes_an_untracked_one() {
        let repo = Repo::with(&["mod.txt", "gone.txt", "old.txt", "kept.txt"]);
        repo.put("mod.txt", "changed");
        std::fs::remove_file(repo.at().join("gone.txt")).unwrap();
        git(&repo.at(), &["mv", "old.txt", "new.txt"]);
        repo.put("fresh.txt", "fresh");
        repo.put("dir/inner.txt", "inner");
        repo.put("staged.txt", "staged");
        git(&repo.at(), &["add", "staged.txt"]);
        repo.put("kept.txt", "still mine");
        for path in ["mod.txt", "gone.txt", "new.txt", "fresh.txt", "dir/inner.txt", "staged.txt"] {
            assert_eq!(discard(&Here::new(), &repo.at(), path).await.unwrap().path, path);
        }
        assert_eq!(repo.short(), " M kept.txt\n");
        assert_eq!(repo.read("mod.txt").as_deref(), Some("mod.txt\n"));
        assert_eq!(repo.read("gone.txt").as_deref(), Some("gone.txt\n"));
        assert_eq!(repo.read("old.txt").as_deref(), Some("old.txt\n"));
        assert_eq!((repo.read("new.txt"), repo.read("fresh.txt"), repo.read("staged.txt")), (None, None, None));
        assert!(!repo.at().join("dir/inner.txt").exists());
    }

    #[tokio::test]
    async fn a_discard_of_the_last_file_in_a_new_folder_takes_the_folder_and_leaves_one_that_still_holds_something() {
        let repo = Repo::with(&["src/kept.txt"]);
        repo.put("new/deep/only.txt", "only");
        repo.put("two/a.txt", "a");
        repo.put("two/b.txt", "b");
        repo.put("src/fresh.txt", "fresh");
        repo.put("staged/one.txt", "one");
        git(&repo.at(), &["add", "staged/one.txt"]);
        for path in ["new/deep/only.txt", "two/a.txt", "src/fresh.txt", "staged/one.txt"] {
            discard(&Here::new(), &repo.at(), path).await.unwrap();
        }
        assert!(!repo.at().join("new").exists());
        assert!(!repo.at().join("staged").exists());
        assert_eq!(repo.read("two/b.txt").as_deref(), Some("b\n"));
        assert_eq!(repo.read("src/kept.txt").as_deref(), Some("src/kept.txt\n"));
        assert_eq!(repo.short(), "?? two/b.txt\n");
    }

    #[tokio::test]
    async fn a_discard_of_a_file_with_no_change_is_refused_by_name() {
        let repo = Repo::with(&["same.txt"]);
        assert_eq!(discard(&Here::new(), &repo.at(), "same.txt").await.unwrap_err().message, words::no_change("same.txt"));
        assert_eq!(discard(&Here::new(), &repo.at(), "never.txt").await.unwrap_err().message, words::no_change("never.txt"));
    }

    #[tokio::test]
    async fn a_write_from_a_folder_under_the_top_names_files_from_the_top() {
        let repo = Repo::with(&["src/a.txt", "b.txt"]);
        repo.put("src/a.txt", "changed");
        repo.put("b.txt", "changed");
        commit(&Here::new(), &repo.at().join("src"), "m\n", &named_paths(&["src/a.txt"])).await.unwrap();
        assert_eq!(repo.short(), " M b.txt\n");
        discard(&Here::new(), &repo.at().join("src"), "b.txt").await.unwrap();
        assert_eq!(repo.short(), "");
    }
}
