// SPDX-License-Identifier: AGPL-3.0-only
//! Every git write a pane or a verb asks of a copy: argv alone through the way of running the frame took, each file
//! named as a `:(top,literal)` pathspec so a `*` in a name is a letter, a message on stdin and never in argv, and one
//! wait for an index another git in the copy holds.

use std::path::Path;
use std::time::Duration;

use wsp_frames::{
    words, DaemonErrorCode, GitCommitReply, GitDiscardReply, GitMergeInReply, GitStartOnReply, GitStatusEntry, GitUpdateReply,
};

use wsp_runtime::copy_road::branch::worktrees_of;

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

/// Merges the base's latest commits from the remote into the branch the checkout is on: fetched, then merged with a
/// merge commit, so a branch already pushed is never rewritten. A checkout holding changes no commit has is refused
/// before anything is fetched, with the files named. A merge that conflicts is taken back at once and answered with
/// the files that conflicted, so the checkout is left as it was and the agent redoes the merge when asked.
pub(crate) async fn update<R: Runs>(runner: &R, cwd: &Path, named_base: Option<&str>) -> Result<GitUpdateReply, OpError> {
    let (remote, _) = crate::bring_back::remote_url(runner, cwd).await?;
    let base = crate::bring_back::base_of(runner, cwd, &remote, named_base).await?;
    Ok(match merge_remote(runner, cwd, From::Remote(&remote), &base, false, &UPDATING).await? {
        Merge::Took { commits, .. } => GitUpdateReply { base, merged: true, commits, conflicts: Vec::new() },
        Merge::Conflicts(conflicts) => GitUpdateReply { base, merged: false, commits: 0, conflicts },
    })
}

/// Merges a child's branch into the branch the checkout is on, always with a merge commit, so the lead's history
/// shows each child landing: from the remote, or from the child's own folder where the project has none and both
/// copies sit on this computer. The same refusals and the same taking back as an update.
pub(crate) async fn merge_in<R: Runs>(runner: &R, cwd: &Path, branch: &str, from: Option<&str>) -> Result<GitMergeInReply, OpError> {
    let remote;
    let source = match from {
        Some(path) => From::Folder(path),
        None => {
            remote = crate::bring_back::remote_url(runner, cwd).await?.0;
            From::Remote(&remote)
        }
    };
    Ok(match merge_remote(runner, cwd, source, branch, true, &MERGING).await? {
        Merge::Took { commits, oid, head } => {
            GitMergeInReply { branch: branch.to_owned(), merged: true, commits, oid: Some(oid), head: Some(head), conflicts: Vec::new() }
        }
        Merge::Conflicts(conflicts) => {
            GitMergeInReply { branch: branch.to_owned(), merged: false, commits: 0, oid: None, head: None, conflicts }
        }
    })
}

/// Puts the checkout on a branch as the remote holds it, as a copy is made: fetched, the branch reset to the remote's
/// commit with its upstream set, and every untracked file dropped, while what git ignores stays.
pub(crate) async fn start_on<R: Runs>(runner: &R, cwd: &Path, branch: &str) -> Result<GitStartOnReply, OpError> {
    let (remote, _) = crate::bring_back::remote_url(runner, cwd).await?;
    let fetched = run_git(runner, cwd, &["fetch", "--no-tags", "--", &remote, branch], None, None).await?;
    if fetched.code != Some(0) {
        if let Some(refusal) = crate::bring_back::no_credential(runner, cwd, &remote, &fetched.stderr, words::no_start_credential).await? {
            return Err(OpError::coded(DaemonErrorCode::NoGitCredential, refusal));
        }
        if fetched.stderr.contains("couldn't find remote ref") {
            return Err(OpError::plain(words::start_on_no_branch(branch)));
        }
        return Err(OpError::plain(words::start_on_refused(branch, &last_line(&fetched))));
    }
    // Asked of git outright rather than left to checkout, which on some versions moves a branch another worktree holds.
    let worktrees = run_git(runner, cwd, &["worktree", "list", "--porcelain", "-z"], None, None).await?;
    check(&worktrees, "worktree list")?;
    let top = run_git(runner, cwd, &["rev-parse", "--show-toplevel"], None, None).await?;
    check(&top, "rev-parse")?;
    if let Some(held) = held_elsewhere(&stdout_text(&worktrees), stdout_text(&top).trim(), branch) {
        return Err(OpError::plain(words::start_on_refused(branch, &format!("it is already checked out at {held}"))));
    }
    let theirs = format!("{remote}/{branch}");
    let put = run_git(runner, cwd, &["checkout", "-q", "-f", "-B", branch, &theirs], None, None).await?;
    if put.code != Some(0) {
        return Err(OpError::plain(words::start_on_refused(branch, &last_line(&put))));
    }
    let cleaned = run_git(runner, cwd, &["clean", "-fdq"], None, None).await?;
    if cleaned.code != Some(0) {
        return Err(OpError::plain(words::start_on_refused(branch, &last_line(&cleaned))));
    }
    let head = run_git(runner, cwd, &["rev-parse", "HEAD"], None, None).await?;
    check(&head, "rev-parse")?;
    Ok(GitStartOnReply { branch: branch.to_owned(), oid: stdout_text(&head).trim().to_owned() })
}

/// The worktree other than this one that has the branch checked out, off `worktree list --porcelain -z`.
fn held_elsewhere(listing: &str, here: &str, branch: &str) -> Option<String> {
    worktrees_of(listing).into_iter().find(|w| w.path != here && w.branch.as_deref() == Some(branch)).map(|w| w.path)
}

/// The repository's own refusal where the folder is none, so a refusal there is not read as git's word on the branch.
fn refused_outside_a_repo(res: &GitResult) -> Result<(), OpError> {
    if res.stderr.to_ascii_lowercase().contains("not a git repository") {
        return Err(super::not_a_repo());
    }
    Ok(())
}

/// A name git takes for a branch and that cannot read as a flag on git's own line.
async fn branch_name<R: Runs>(runner: &R, cwd: &Path, name: &str) -> Result<(), OpError> {
    let checked = run_git(runner, cwd, &["check-ref-format", &format!("refs/heads/{name}")], None, None).await?;
    if name.starts_with('-') || checked.code != Some(0) {
        return Err(OpError::coded(DaemonErrorCode::BadRequest, words::not_a_branch_name(name)));
    }
    Ok(())
}

/// Puts the checkout on a new branch made at its HEAD: every change in it, staged or not, comes along and nothing
/// is reset, so the work in the folder moves onto the branch as it stands.
pub(crate) async fn switch_new<R: Runs>(runner: &R, cwd: &Path, branch: &str) -> Result<GitStartOnReply, OpError> {
    branch_name(runner, cwd, branch).await?;
    let mut put = run_git(runner, cwd, &["switch", "-q", "-c", branch], None, None).await?;
    if put.code != Some(0) && put.stderr.contains("index.lock") {
        tokio::time::sleep(LOCK_WAIT).await;
        put = run_git(runner, cwd, &["switch", "-q", "-c", branch], None, None).await?;
    }
    if put.code != Some(0) {
        refused_outside_a_repo(&put)?;
        return Err(OpError::plain(words::switch_new_refused(branch, &last_line(&put))));
    }
    let head = run_git(runner, cwd, &["rev-parse", "HEAD"], None, None).await?;
    check(&head, "rev-parse")?;
    Ok(GitStartOnReply { branch: branch.to_owned(), oid: stdout_text(&head).trim().to_owned() })
}

/// One branch of a remote, named or given by its URL, fetched into a local branch of this repository: made where it
/// is not there and moved only forward where it is, never forced, so a branch the person holds is never reset and
/// one checked out anywhere is git's to refuse.
pub(crate) async fn fetch_branch<R: Runs>(
    runner: &R,
    cwd: &Path,
    remote: &str,
    branch: &str,
    into: Option<&str>,
) -> Result<GitStartOnReply, OpError> {
    let into = into.unwrap_or(branch);
    for name in [branch, into] {
        branch_name(runner, cwd, name).await?;
    }
    if remote.is_empty() || remote.starts_with('-') {
        return Err(OpError::coded(DaemonErrorCode::BadRequest, format!("{remote:?} is not a remote")));
    }
    let spec = format!("refs/heads/{branch}:refs/heads/{into}");
    let fetched = run_git(runner, cwd, &["fetch", "--no-tags", "--", remote, &spec], None, None).await?;
    if fetched.code != Some(0) {
        if let Some(refusal) = crate::bring_back::no_credential(runner, cwd, remote, &fetched.stderr, words::no_start_credential).await? {
            return Err(OpError::coded(DaemonErrorCode::NoGitCredential, refusal));
        }
        if fetched.stderr.contains("couldn't find remote ref") {
            return Err(OpError::plain(words::start_on_no_branch(branch)));
        }
        refused_outside_a_repo(&fetched)?;
        return Err(OpError::plain(words::fetch_branch_refused(into, &last_line(&fetched))));
    }
    let tip = run_git(runner, cwd, &["rev-parse", "--verify", &format!("refs/heads/{into}")], None, None).await?;
    check(&tip, "rev-parse")?;
    Ok(GitStartOnReply { branch: into.to_owned(), oid: stdout_text(&tip).trim().to_owned() })
}

/// Where a merge's other side is fetched from.
enum From<'a> {
    Remote(&'a str),
    /// A checkout's folder on this computer, which is an agent's repository: the fetch runs its upload-pack under
    /// overrides that neither repository's config can move.
    Folder(&'a str),
}

/// What a merge came to: taken, with the commits it brought, the commit it left and the other side's commit it took;
/// or taken back, with the files.
enum Merge {
    Took { commits: u64, oid: String, head: String },
    Conflicts(Vec<String>),
}

/// The sentences one kind of merge is refused with.
struct MergeWords {
    dirty: fn(&[String]) -> String,
    credential: fn(&str, Option<&str>) -> String,
    refused: fn(&str) -> String,
}

const UPDATING: MergeWords =
    MergeWords { dirty: words::update_dirty, credential: words::no_fetch_credential, refused: words::update_refused };
const MERGING: MergeWords =
    MergeWords { dirty: words::merge_in_dirty, credential: words::no_merge_credential, refused: words::merge_refused };

/// The one merge every git road takes: a checkout with changes no commit holds refused by name before anything
/// moves, the other side fetched, merged with a merge commit, and a merge that stopped taken back before anything
/// is answered. The two overrides stop a command a repository's config names from running on the fetch: the
/// served folder's pack-objects hook, which git reads only from protected config anyway, and the alternate refs
/// command, which git runs from the fetching checkout's own config once it has alternates. The upload-pack program
/// is named, so nothing configured picks it, and lazy fetching is off whatever the daemon's environment says, since a
/// served partial clone fetches what it lacks through the upload-pack its own remote's config names.
async fn merge_remote<R: Runs>(
    runner: &R,
    cwd: &Path,
    from: From<'_>,
    branch: &str,
    no_ff: bool,
    said: &MergeWords,
) -> Result<Merge, OpError> {
    let (root, entries) = changes(runner, cwd).await?;
    let copy = named(&root).to_owned();
    let top = Path::new(&root);
    let dirty: Vec<String> = entries.iter().filter(|e| e.xy != "??" && e.xy != "!!").map(|e| e.path.clone()).collect();
    if !dirty.is_empty() {
        return Err(OpError::plain((said.dirty)(&dirty)));
    }
    let (fetch, theirs): (Vec<&str>, String) = match from {
        From::Remote(remote) => (vec!["fetch", "--no-tags", "--", remote, branch], format!("{remote}/{branch}")),
        From::Folder(path) => (
            vec![
                "GIT_NO_LAZY_FETCH=1",
                "git",
                "-c",
                "uploadpack.packObjectsHook=",
                "-c",
                "core.alternateRefsCommand=",
                "fetch",
                "--no-tags",
                "--upload-pack=git-upload-pack",
                "--",
                path,
                branch,
            ],
            "FETCH_HEAD".to_owned(),
        ),
    };
    let fetched = match from {
        From::Remote(_) => run_git(runner, top, &fetch, None, None).await?,
        From::Folder(_) => runner.run(top, "env", &fetch, None, None).await?,
    };
    if fetched.code != Some(0) {
        if let From::Remote(remote) = from {
            if let Some(refusal) = crate::bring_back::no_credential(runner, top, remote, &fetched.stderr, said.credential).await? {
                return Err(OpError::coded(DaemonErrorCode::NoGitCredential, refusal));
            }
        }
        return Err(refusal_as(&fetched, &copy, said.refused));
    }
    let before = run_git(runner, top, &["rev-parse", "HEAD"], None, None).await?;
    check(&before, "rev-parse")?;
    let before = stdout_text(&before).trim().to_owned();
    let mut merge = vec!["merge", "--no-edit"];
    if no_ff {
        merge.push("--no-ff");
    }
    merge.push(&theirs);
    let merged = run_git(runner, top, &merge, None, None).await?;
    if merged.code == Some(0) {
        let counted = run_git(runner, top, &["rev-list", "--count", &format!("{before}..{theirs}")], None, None).await?;
        check(&counted, "rev-list")?;
        let after = run_git(runner, top, &["rev-parse", "HEAD"], None, None).await?;
        check(&after, "rev-parse")?;
        let took = run_git(runner, top, &["rev-parse", "--verify", &format!("{theirs}^{{commit}}")], None, None).await?;
        check(&took, "rev-parse")?;
        return Ok(Merge::Took {
            commits: stdout_text(&counted).trim().parse().unwrap_or(0),
            oid: stdout_text(&after).trim().to_owned(),
            head: stdout_text(&took).trim().to_owned(),
        });
    }
    // Whatever stopped the merge, one in progress is taken back before anything is answered.
    let underway = run_git(runner, top, &["rev-parse", "-q", "--verify", "MERGE_HEAD"], None, None).await?;
    if underway.code != Some(0) {
        return Err(refusal_as(&merged, &copy, said.refused));
    }
    let listed = run_git(runner, top, &["diff", "--name-only", "--diff-filter=U", "-z"], None, None).await?;
    let conflicts: Vec<String> = stdout_text(&listed).split('\0').filter(|p| !p.is_empty()).map(str::to_owned).collect();
    let aborted = run_git(runner, top, &["merge", "--abort"], None, None).await?;
    check(&aborted, "merge --abort")?;
    if conflicts.is_empty() {
        return Err(refusal_as(&merged, &copy, said.refused));
    }
    Ok(Merge::Conflicts(conflicts))
}

/// git's own last line that is not blank, off stderr before stdout.
fn last_line(res: &GitResult) -> String {
    let out = stdout_text(res);
    let said =
        [res.stderr.as_str(), out.as_str()].into_iter().flat_map(|text| text.lines().rev()).map(str::trim).find(|line| !line.is_empty());
    said.unwrap_or("git gave no reason").to_owned()
}

/// Why git refused a merge, as one sentence: a held index, a copy with no author for the merge commit, or git's own
/// last line in the words of the merge asked for.
fn refusal_as(res: &GitResult, copy: &str, refused_with: fn(&str) -> String) -> OpError {
    let refused = refusal_of(res, copy);
    let said = last_line(res);
    if refused.message == words::commit_refused(&said) {
        OpError::plain(refused_with(&said))
    } else {
        refused
    }
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

    /// A checkout on a branch of its own with one commit over main, its bare origin beside it, and a second clone
    /// standing in for everybody else pushing to main.
    struct Pushed {
        dir: tempfile::TempDir,
    }

    impl Pushed {
        fn new() -> Pushed {
            let dir = tempfile::Builder::new().prefix("wsp-update-").tempdir().unwrap();
            let origin = dir.path().join("origin.git");
            git(dir.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
            for side in ["work", "other"] {
                git(dir.path(), &["clone", "-q", origin.to_str().unwrap(), side]);
                let at = dir.path().join(side);
                git(&at, &["config", "commit.gpgsign", "false"]);
                git(&at, &["config", "user.name", "t"]);
                git(&at, &["config", "user.email", "t@x"]);
                if side == "work" {
                    std::fs::write(at.join("README.md"), "line one\nline two\n").unwrap();
                    git(&at, &["add", "-A"]);
                    git(&at, &["commit", "-q", "-m", "first"]);
                    git(&at, &["push", "-q", "origin", "main"]);
                    git(&at, &["checkout", "-q", "-b", "work"]);
                    std::fs::write(at.join("work.txt"), "mine\n").unwrap();
                    git(&at, &["add", "-A"]);
                    git(&at, &["commit", "-q", "-m", "mine"]);
                } else {
                    git(&at, &["pull", "-q", "origin", "main"]);
                }
            }
            Pushed { dir }
        }

        fn work(&self) -> PathBuf {
            self.dir.path().join("work")
        }

        /// Somebody else lands a commit on main that writes this file.
        fn main_moves(&self, file: &str, text: &str) {
            let other = self.dir.path().join("other");
            std::fs::write(other.join(file), text).unwrap();
            git(&other, &["add", "-A"]);
            git(&other, &["commit", "-q", "-m", &format!("main writes {file}")]);
            git(&other, &["push", "-q", "origin", "main"]);
        }

        /// Somebody else pushes a branch cut from the remote's `from`, with one commit writing this file.
        fn other_pushes(&self, branch: &str, from: &str, file: &str, text: &str) {
            let other = self.dir.path().join("other");
            git(&other, &["fetch", "-q", "origin", from]);
            git(&other, &["checkout", "-q", "-B", branch, &format!("origin/{from}")]);
            std::fs::write(other.join(file), text).unwrap();
            git(&other, &["add", "-A"]);
            git(&other, &["commit", "-q", "-m", &format!("{branch} writes {file}")]);
            git(&other, &["push", "-q", "origin", branch]);
        }

        /// Every entry the index stages, with its mode, its blob and its stage, beside what looks shows: a merge taken
        /// back must leave it as it was. The stat data git keeps beside them is rewritten by any index write.
        fn index(&self) -> String {
            git(&self.work(), &["ls-files", "--stage"])
        }

        /// Everything a person could see of the checkout: HEAD, git's status, and every file's bytes.
        fn looks(&self) -> (String, String, Vec<(String, Vec<u8>)>) {
            let at = self.work();
            let mut files: Vec<(String, Vec<u8>)> = std::fs::read_dir(&at)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.is_file())
                .map(|p| (p.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()))
                .collect();
            files.sort();
            (git(&at, &["rev-parse", "HEAD"]), git(&at, &["status", "--porcelain=v2", "--branch"]), files)
        }
    }

    #[tokio::test]
    async fn an_update_merges_the_bases_new_commits_and_counts_what_it_brought() {
        let repo = Pushed::new();
        repo.main_moves("other.txt", "theirs\n");
        repo.main_moves("third.txt", "more\n");
        let done = update(&Here::new(), &repo.work(), Some("main")).await.unwrap();
        assert_eq!(done, GitUpdateReply { base: "main".to_owned(), merged: true, commits: 2, conflicts: Vec::new() });
        let log = git(&repo.work(), &["log", "--format=%s", "-4"]);
        assert!(log.starts_with("Merge remote-tracking branch 'origin/main' into work\n"), "{log}");
        assert_eq!(std::fs::read_to_string(repo.work().join("other.txt")).unwrap(), "theirs\n");
        // A base with nothing new merges nothing and says so with a zero.
        assert_eq!(
            update(&Here::new(), &repo.work(), None).await.unwrap(),
            GitUpdateReply { base: "main".to_owned(), merged: true, commits: 0, conflicts: Vec::new() }
        );
    }

    #[tokio::test]
    async fn an_update_that_conflicts_names_the_files_and_leaves_the_checkout_exactly_as_it_was() {
        let repo = Pushed::new();
        std::fs::write(repo.work().join("README.md"), "line one, mine\nline two\n").unwrap();
        git(&repo.work(), &["commit", "-q", "-am", "mine on line one"]);
        repo.main_moves("README.md", "line one, theirs\nline two\n");
        std::fs::write(repo.work().join("scratch.txt"), "not committed, not tracked\n").unwrap();
        let before = repo.looks();
        let done = update(&Here::new(), &repo.work(), Some("main")).await.unwrap();
        assert_eq!(done, GitUpdateReply { base: "main".to_owned(), merged: false, commits: 0, conflicts: vec!["README.md".to_owned()] });
        assert_eq!(repo.looks(), before);
        assert!(!repo.work().join(".git/MERGE_HEAD").exists());
    }

    #[tokio::test]
    async fn an_update_over_changes_no_commit_holds_is_refused_with_the_files_and_fetches_nothing() {
        let repo = Pushed::new();
        repo.main_moves("other.txt", "theirs\n");
        std::fs::write(repo.work().join("README.md"), "edited\n").unwrap();
        std::fs::write(repo.work().join("work.txt"), "edited too\n").unwrap();
        let err = update(&Here::new(), &repo.work(), Some("main")).await.unwrap_err();
        assert_eq!(err.message, words::update_dirty(&["README.md".to_owned(), "work.txt".to_owned()]));
        assert_eq!(err.message, "commit or discard the changes in README.md, work.txt before updating");
        assert!(
            git(&repo.work(), &["rev-parse", "-q", "--verify", "origin/main"]).trim()
                != git(&repo.dir.path().join("other"), &["rev-parse", "HEAD"]).trim()
        );
        // A file nothing tracks is no reason to refuse.
        git(&repo.work(), &["checkout", "-q", "--", "README.md", "work.txt"]);
        std::fs::write(repo.work().join("scratch.txt"), "loose\n").unwrap();
        assert!(update(&Here::new(), &repo.work(), Some("main")).await.unwrap().merged);
    }

    #[tokio::test]
    async fn an_update_in_a_checkout_with_no_remote_is_refused_as_a_push_is() {
        let repo = Repo::with(&["a.txt"]);
        assert_eq!(update(&Here::new(), &repo.at(), Some("main")).await.unwrap_err().message, words::NO_REMOTE);
    }

    #[tokio::test]
    async fn a_copy_started_on_a_pushed_branch_stands_at_the_remotes_commit_with_nothing_untracked_left() {
        let repo = Pushed::new();
        git(&repo.work(), &["push", "-q", "origin", "work"]);
        repo.other_pushes("tree/lead", "work", "lead.txt", "the lead's\n");
        let child = repo.dir.path().join("child");
        git(repo.dir.path(), &["clone", "-q", repo.dir.path().join("origin.git").to_str().unwrap(), "child"]);
        std::fs::write(child.join("loose.txt"), "left by the copy\n").unwrap();
        let done = start_on(&Here::new(), &child, "tree/lead").await.unwrap();
        let tip = git(&repo.dir.path().join("other"), &["rev-parse", "HEAD"]);
        assert_eq!(done, GitStartOnReply { branch: "tree/lead".to_owned(), oid: tip.trim().to_owned() });
        assert_eq!(git(&child, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "tree/lead");
        assert_eq!(git(&child, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(), "origin/tree/lead");
        assert_eq!(std::fs::read_to_string(child.join("lead.txt")).unwrap(), "the lead's\n");
        assert!(!child.join("loose.txt").exists());
    }

    #[tokio::test]
    async fn a_copy_is_not_started_on_a_branch_the_remote_lacks_or_one_another_worktree_holds() {
        let repo = Pushed::new();
        let err = start_on(&Here::new(), &repo.work(), "tree/nowhere").await.unwrap_err();
        assert_eq!(err.message, words::start_on_no_branch("tree/nowhere"));
        git(&repo.work(), &["push", "-q", "origin", "work"]);
        let beside = repo.dir.path().join("beside");
        git(&repo.work(), &["worktree", "add", "-q", "--detach", beside.to_str().unwrap()]);
        let err = start_on(&Here::new(), &beside, "work").await.unwrap_err();
        assert!(err.message.starts_with("the copy could not be put on work: "), "{}", err.message);
        assert!(err.message.contains("work"), "{}", err.message);
    }

    #[tokio::test]
    async fn a_new_branch_takes_every_change_in_the_folder_along_and_resets_nothing() {
        let repo = Repo::with(&["a.txt", "b.txt"]);
        let head = git(&repo.at(), &["rev-parse", "HEAD"]).trim().to_owned();
        repo.put("a.txt", "edited");
        repo.put("new.txt", "untracked");
        git(&repo.at(), &["add", "b.txt"]);
        repo.put("b.txt", "staged then edited");
        let before = repo.short();
        let done = switch_new(&Here::new(), &repo.at(), "feat/moved").await.unwrap();
        assert_eq!(done, GitStartOnReply { branch: "feat/moved".to_owned(), oid: head.clone() });
        assert_eq!(git(&repo.at(), &["symbolic-ref", "--short", "HEAD"]).trim(), "feat/moved");
        assert_eq!(repo.short(), before, "the changes moved or went");
        assert_eq!(git(&repo.at(), &["rev-parse", "main"]).trim(), head);
        // A branch already there is refused in one sentence and the folder stays where it was.
        let err = switch_new(&Here::new(), &repo.at(), "main").await.unwrap_err();
        assert!(err.message.starts_with("the folder could not be put on a new branch main: "), "{}", err.message);
        assert_eq!(git(&repo.at(), &["symbolic-ref", "--short", "HEAD"]).trim(), "feat/moved");
        for bad in ["-f", "a..b", "x.lock"] {
            let err = switch_new(&Here::new(), &repo.at(), bad).await.unwrap_err();
            assert_eq!((err.code, err.message), (Some(DaemonErrorCode::BadRequest), words::not_a_branch_name(bad)));
        }
    }

    #[tokio::test]
    async fn a_fetched_branch_lands_in_a_local_branch_moves_only_forward_and_never_resets_one_the_person_has() {
        let repo = Pushed::new();
        repo.other_pushes("pr/one", "main", "pr.txt", "the pr's\n");
        let tip = git(&repo.dir.path().join("other"), &["rev-parse", "HEAD"]).trim().to_owned();
        let work = repo.work();
        let done = fetch_branch(&Here::new(), &work, "origin", "pr/one", None).await.unwrap();
        assert_eq!(done, GitStartOnReply { branch: "pr/one".to_owned(), oid: tip.clone() });
        assert_eq!(git(&work, &["rev-parse", "refs/heads/pr/one"]).trim(), tip);
        assert_eq!(git(&work, &["symbolic-ref", "--short", "HEAD"]).trim(), "work", "the folder stayed on its branch");
        // By URL into a name of its own, as a fork's branch lands.
        let url = repo.dir.path().join("origin.git");
        let done = fetch_branch(&Here::new(), &work, url.to_str().unwrap(), "pr/one", Some("fork/pr-one")).await.unwrap();
        assert_eq!(done.branch, "fork/pr-one");
        // The person's own branch of the name, holding a commit the remote lacks, is refused and stays where it was.
        git(&work, &["branch", "-f", "mine", "work"]);
        let mine = git(&work, &["rev-parse", "mine"]).trim().to_owned();
        let err = fetch_branch(&Here::new(), &work, "origin", "pr/one", Some("mine")).await.unwrap_err();
        assert!(err.message.starts_with("mine was not fetched: "), "{}", err.message);
        assert_eq!(git(&work, &["rev-parse", "mine"]).trim(), mine, "a branch the person has was reset");
        // One checked out is refused by git, and a branch the remote lacks says so.
        let err = fetch_branch(&Here::new(), &work, "origin", "main", Some("work")).await.unwrap_err();
        assert!(err.message.starts_with("work was not fetched: "), "{}", err.message);
        assert_eq!(
            fetch_branch(&Here::new(), &work, "origin", "nowhere", None).await.unwrap_err().message,
            words::start_on_no_branch("nowhere")
        );
        assert_eq!(
            fetch_branch(&Here::new(), &work, "--upload-pack=x", "main", None).await.unwrap_err().code,
            Some(DaemonErrorCode::BadRequest)
        );
    }

    #[tokio::test]
    async fn a_child_merged_in_takes_a_merge_commit_even_where_it_could_fast_forward() {
        let repo = Pushed::new();
        git(&repo.work(), &["push", "-q", "origin", "work"]);
        repo.other_pushes("child/one", "work", "one.txt", "the child's\n");
        let done = merge_in(&Here::new(), &repo.work(), "child/one", None).await.unwrap();
        let head = git(&repo.work(), &["rev-parse", "HEAD"]).trim().to_owned();
        let took = git(&repo.work(), &["rev-parse", "origin/child/one"]).trim().to_owned();
        assert_eq!(
            done,
            GitMergeInReply {
                branch: "child/one".to_owned(),
                merged: true,
                commits: 1,
                oid: Some(head),
                head: Some(took),
                conflicts: Vec::new()
            }
        );
        assert_eq!(git(&repo.work(), &["log", "-1", "--format=%s"]).trim(), "Merge remote-tracking branch 'origin/child/one' into work");
        assert_eq!(git(&repo.work(), &["rev-list", "--parents", "-1", "HEAD"]).split_whitespace().count(), 3);
        assert_eq!(std::fs::read_to_string(repo.work().join("one.txt")).unwrap(), "the child's\n");
        // A child already in the lead merges nothing and says so with a zero.
        let again = merge_in(&Here::new(), &repo.work(), "child/one", None).await.unwrap();
        assert_eq!((again.merged, again.commits, again.conflicts.len()), (true, 0, 0));
        assert_eq!(git(&repo.work(), &["rev-parse", "HEAD"]).trim(), done.oid.unwrap());
    }

    #[tokio::test]
    async fn a_child_that_conflicts_names_the_files_and_leaves_head_the_index_and_the_status_as_they_were() {
        let repo = Pushed::new();
        git(&repo.work(), &["push", "-q", "origin", "work"]);
        repo.other_pushes("child/two", "work", "README.md", "line one, the child's\nline two\n");
        std::fs::write(repo.work().join("README.md"), "line one, the lead's\nline two\n").unwrap();
        git(&repo.work(), &["commit", "-q", "-am", "the lead on line one"]);
        std::fs::write(repo.work().join("scratch.txt"), "not tracked\n").unwrap();
        let (before, index) = (repo.looks(), repo.index());
        let done = merge_in(&Here::new(), &repo.work(), "child/two", None).await.unwrap();
        assert_eq!(
            done,
            GitMergeInReply {
                branch: "child/two".to_owned(),
                merged: false,
                commits: 0,
                oid: None,
                head: None,
                conflicts: vec!["README.md".to_owned()]
            }
        );
        assert_eq!((repo.looks(), repo.index()), (before, index));
        assert!(!repo.work().join(".git/MERGE_HEAD").exists());
    }

    #[tokio::test]
    async fn a_lead_with_changes_no_commit_holds_is_refused_by_name_before_anything_is_fetched() {
        let repo = Pushed::new();
        git(&repo.work(), &["push", "-q", "origin", "work"]);
        repo.other_pushes("child/three", "work", "three.txt", "x\n");
        std::fs::write(repo.work().join("work.txt"), "edited\n").unwrap();
        let err = merge_in(&Here::new(), &repo.work(), "child/three", None).await.unwrap_err();
        assert_eq!(err.message, words::merge_in_dirty(&["work.txt".to_owned()]));
        assert!(git(&repo.work(), &["branch", "-r"]).lines().all(|l| !l.contains("child/three")));
    }

    #[tokio::test]
    async fn a_merge_from_a_folder_names_the_overrides_and_the_pinned_upload_pack_before_fetch_and_merges_fetch_head() {
        // status, the top, the fetch, HEAD before, the merge, the count, HEAD after, the commit taken.
        let runner = crate::git::recorded::Recorded::new(&[]).answering(vec![
            (0, ""),
            (0, "/lead\n"),
            (0, ""),
            (0, "aaa\n"),
            (0, ""),
            (0, "1\n"),
            (0, "bbb\n"),
            (0, "ccc\n"),
        ]);
        let done = merge_in(&runner, Path::new("/lead"), "child/one", Some("/copies/child one")).await.unwrap();
        assert_eq!((done.merged, done.commits, done.oid.as_deref(), done.head.as_deref()), (true, 1, Some("bbb"), Some("ccc")));
        let calls = runner.asked();
        assert!(calls.iter().any(|c| c.program == "env" && c.args.contains(&"fetch".to_owned())));
        let asked: Vec<Vec<String>> = calls.into_iter().map(|c| c.args).collect();
        let fetch = asked.iter().find(|a| a.contains(&"fetch".to_owned())).unwrap();
        assert_eq!(
            fetch,
            &[
                "GIT_NO_LAZY_FETCH=1",
                "git",
                "-c",
                "uploadpack.packObjectsHook=",
                "-c",
                "core.alternateRefsCommand=",
                "fetch",
                "--no-tags",
                "--upload-pack=git-upload-pack",
                "--",
                "/copies/child one",
                "child/one"
            ]
            .map(str::to_owned)
        );
        assert!(asked.iter().any(|a| a == &["merge", "--no-edit", "--no-ff", "FETCH_HEAD"].map(str::to_owned)), "{asked:?}");
    }

    /// Every key a served repository's config can set that names a command, and every hook, each writing a marker
    /// of its own name when run; the fetch of a merge from that repository's folder runs none of them. The hooks are
    /// shown live first by a checkout in the served repository itself, so a marker that never appears is a hook not
    /// run rather than one that could not run. The fetching checkout's own alternateRefsCommand, which git runs from
    /// the fetching side's config once it has alternates, is the one a plain fetch does run.
    #[tokio::test]
    async fn a_merge_from_a_folder_runs_nothing_either_repository_configures() {
        let repo = Pushed::new();
        let at = repo.dir.path();
        let marks = at.join("marks");
        std::fs::create_dir(&marks).unwrap();
        let mark = |name: &str| format!("touch {}/{name}; true", marks.display());
        let child = at.join("child");
        git(at, &["clone", "-q", at.join("origin.git").to_str().unwrap(), "child"]);
        git(&child, &["checkout", "-q", "-b", "child/one"]);
        std::fs::write(child.join("one.txt"), "one\n").unwrap();
        git(&child, &["add", "-A"]);
        git(&child, &["commit", "-q", "-m", "one"]);
        let third = at.join("third");
        git(at, &["init", "-q", "-b", "main", third.to_str().unwrap()]);
        git(&third, &["commit", "-q", "--allow-empty", "-m", "third"]);
        std::fs::write(child.join(".git/objects/info/alternates"), format!("{}\n", third.join(".git/objects").display())).unwrap();
        let keys = [
            "uploadpack.packObjectsHook",
            "core.alternateRefsCommand",
            "core.fsmonitor",
            "core.sshCommand",
            "core.gitProxy",
            "core.askPass",
            "credential.helper",
            "core.pager",
            "pager.upload-pack",
            "uploadpack.hideRefsCommand",
            "core.editor",
            "sequence.editor",
            "gpg.program",
            "diff.external",
            "receive.procReceiveRefs",
            "remote.origin.uploadpack",
            "remote.origin.receivepack",
            "protocol.ext.allow",
        ];
        for key in keys {
            git(&child, &["config", key, &mark(key)]);
        }
        let hooks = at.join("hooks");
        std::fs::create_dir(&hooks).unwrap();
        for hook in [
            "pre-upload-pack",
            "post-upload-pack",
            "reference-transaction",
            "post-checkout",
            "pre-auto-gc",
            "fsmonitor-watchman",
            "post-index-change",
            "push-to-checkout",
            "proc-receive",
        ] {
            let script = format!("#!/bin/sh\n{}\n", mark(&format!("hook-{hook}")));
            for dir in [hooks.clone(), child.join(".git/hooks")] {
                let file = dir.join(hook);
                std::fs::write(&file, &script).unwrap();
                std::fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            }
        }
        git(&child, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
        // Live: a checkout in the served repository runs its post-checkout hook.
        git(&child, &["-c", "core.fsmonitor=", "checkout", "-q", "child/one"]);
        assert!(marks.join("hook-post-checkout").exists());
        for e in std::fs::read_dir(&marks).unwrap() {
            std::fs::remove_file(e.unwrap().path()).unwrap();
        }
        // The fetching checkout's own key, which a plain fetch runs.
        std::fs::write(repo.work().join(".git/objects/info/alternates"), format!("{}\n", third.join(".git/objects").display())).unwrap();
        git(&repo.work(), &["config", "core.alternateRefsCommand", &mark("lead-alternateRefsCommand")]);
        let done = merge_in(&Here::new(), &repo.work(), "child/one", Some(child.to_str().unwrap())).await.unwrap();
        assert_eq!((done.merged, done.commits), (true, 1));
        let ran: Vec<String> = std::fs::read_dir(&marks).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(ran, Vec::<String>::new());
        // What the override is for: the same fetch without it runs the fetching side's command.
        git(&repo.work(), &["fetch", "-q", "--no-tags", child.to_str().unwrap(), "child/one"]);
        assert!(marks.join("lead-alternateRefsCommand").exists());
    }

    /// Git as the daemon runs it, under an environment that turns lazy fetching back on.
    struct LazyOn;

    impl Runs for LazyOn {
        async fn run(
            &self,
            cwd: &Path,
            program: &str,
            args: &[&str],
            input: Option<&[u8]>,
            max_bytes: Option<usize>,
        ) -> Result<GitResult, OpError> {
            let mut all = vec!["GIT_NO_LAZY_FETCH=0", program];
            all.extend_from_slice(args);
            Here::new().run(cwd, "env", &all, input, max_bytes).await
        }

        async fn on_path(&self, program: &str) -> Result<bool, OpError> {
            Here::new().on_path(program).await
        }

        fn on_this_side(&self, folder: &Path) -> Option<crate::git::OnThisSide> {
            Here::new().on_this_side(folder)
        }
    }

    /// A served repository that is a partial clone asks its promisor remote for an object it lacks through the
    /// upload-pack that remote's config names, which is the one command upload-pack itself runs. The merge's fetch
    /// keeps that off whatever the daemon's own environment says.
    #[tokio::test]
    async fn a_merge_from_a_partial_clone_fetches_nothing_lazily_whatever_the_environment_says() {
        let repo = Pushed::new();
        let at = repo.dir.path();
        let origin = at.join("origin.git");
        let other = at.join("other");
        git(&other, &["checkout", "-q", "-b", "extra"]);
        std::fs::write(other.join("extra.txt"), "a blob the lead has never seen\n").unwrap();
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-q", "-m", "extra"]);
        git(&other, &["push", "-q", "origin", "extra"]);
        git(&origin, &["config", "uploadpack.allowFilter", "true"]);
        let child = at.join("child");
        git(at, &["clone", "-q", "--no-checkout", "--filter=blob:none", &format!("file://{}", origin.display()), "child"]);
        git(&child, &["branch", "child/one", "origin/extra"]);
        let marker = at.join("lazy");
        git(&child, &["config", "remote.origin.uploadpack", &format!("touch {}; git-upload-pack", marker.display())]);
        let _ = merge_in(&LazyOn, &repo.work(), "child/one", Some(child.to_str().unwrap())).await;
        assert!(!marker.exists(), "the served repository's promisor upload-pack ran");
    }

    /// A branch is an agent's to name, and git reads options after the remote: one named as an option is a branch
    /// on every fetch, so its upload-pack never runs.
    #[tokio::test]
    async fn a_branch_named_as_an_option_is_never_read_as_one_by_a_fetch() {
        let repo = Pushed::new();
        let marker = repo.dir.path().join("ran");
        let branch = format!("--upload-pack=touch${{IFS}}{};git-upload-pack", marker.display());
        let _ = merge_in(&Here::new(), &repo.work(), &branch, None).await;
        assert!(!marker.exists(), "merge_in's fetch read the branch as an option");
        let _ = start_on(&Here::new(), &repo.work(), &branch).await;
        assert!(!marker.exists(), "start_on's fetch read the branch as an option");
    }

    #[test]
    fn more_than_five_dirty_files_are_counted_past_the_fifth() {
        let files: Vec<String> = (1..=7).map(|n| format!("f{n}.txt")).collect();
        assert_eq!(
            words::update_dirty(&files),
            "commit or discard the changes in f1.txt, f2.txt, f3.txt, f4.txt, f5.txt and 2 more before updating"
        );
    }
}
