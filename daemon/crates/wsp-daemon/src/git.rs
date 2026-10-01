// SPDX-License-Identifier: AGPL-3.0-only
//! git through the git binary, never a library: one parser of porcelain v2, and the diff pane's shared byte budget.
//!
//! Where that binary runs is one seam, `Runs`, with a module per way: `here` runs it on the computer this daemon
//! is, `inside` runs it in one workspace this daemon holds. A workspace on a computer somebody owns runs no daemon
//! of its own, so this daemon answers its git, and it runs that git inside the workspace: a checkout's hooks and
//! its config are agent-written and run code, and code of a workspace's belongs in that workspace's namespaces,
//! its cgroup and its covers rather than as root on the computer. Adding a third way is a module and nothing in
//! the callers. A stopped workspace has nothing to run git in, so `stored` reads its branch off the copy's files
//! and runs no program at all.

use std::future::Future;
use std::path::{Path, PathBuf};

use wsp_frames::{DaemonErrorCode, GitBranch, GitDiffFile, GitDiffReply, GitDiffScope, GitStatusEntry, GitStatusReply};

use crate::fs::utf8_text;
use crate::paths::OpError;

pub(crate) mod checkpoint;
pub(crate) mod here;
pub(crate) mod untracked;
use untracked::Seen;
#[cfg(target_os = "linux")]
pub(crate) mod inside;
pub(crate) mod stored;
pub(crate) mod write;

/// What a frame is doing to the workspace it names, which is what that workspace's quiet clock reads. A pane
/// reading a checkout's status, its diff or a folder asks the workspace nothing: it may be read a hundred times
/// over an afternoon nobody is working, and a workspace nobody is working in is one this computer may stop.
/// Pushing a branch, opening a pull request or reading one back is work somebody asked for, and starts that
/// clock over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Asked {
    Read,
    Work,
}

pub(crate) struct GitResult {
    /// None when a signal ended the program, which is what the byte cap does.
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
    /// stdout passed the cap; the program was killed and code is None.
    pub(crate) truncated: bool,
}

/// One way to run a program for a git operation. Both ways carry the same environment: GIT_OPTIONAL_LOCKS keeps a
/// status from touching the index, LC_ALL=C keeps the not-a-repo message matchable, GIT_TERMINAL_PROMPT keeps a
/// push that wants a credential from waiting on a person who is not there, and the work score line puts the
/// process where every shell of ours runs, last for the kernel's memory killer.
pub(crate) trait Runs {
    /// The program with its arguments in that directory, stdin fed then closed, stdout under an optional cap past
    /// which the program is killed.
    fn run(
        &self,
        cwd: &Path,
        program: &str,
        args: &[&str],
        input: Option<&[u8]>,
        max_bytes: Option<usize>,
    ) -> impl Future<Output = Result<GitResult, OpError>> + Send;
    /// Whether that program is on the PATH this way of running finds programs on: a computer with no gh and a
    /// workspace with no gh read the same to whoever asked for a pull request, and neither is a failure.
    fn on_path(&self, program: &str) -> impl Future<Output = Result<bool, OpError>> + Send;
    /// Where this daemon opens `folder`, the folder a caller may read as the program names it, on its own side:
    /// every way of running says so itself, since a folder opened by a path a writer can reach is a folder a writer
    /// can swap. None where this side cannot open it.
    fn on_this_side(&self, folder: &Path) -> Option<OnThisSide>;
}

/// A folder a program named, as this daemon opens it: `open` opened as it is, then `walk` below it a folder at a
/// time with no link followed and no way up.
#[derive(Clone)]
pub(crate) struct OnThisSide {
    pub(crate) open: PathBuf,
    pub(crate) walk: PathBuf,
}

/// The environment every git and every host command line of ours runs with, as shell exports: one line, so the two
/// ways of running cannot part ways on it.
pub(crate) const GIT_ENV: [(&str, &str); 3] = [("GIT_OPTIONAL_LOCKS", "0"), ("GIT_TERMINAL_PROMPT", "0"), ("LC_ALL", "C")];

/// Runs git through the way given: the one place the program is named git.
pub(crate) async fn run_git<R: Runs>(
    runner: &R,
    cwd: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    max_bytes: Option<usize>,
) -> Result<GitResult, OpError> {
    runner.run(cwd, "git", args, input, max_bytes).await
}

/// Exit 0 and 1 are answers, a cut is the cap's doing; anything else failed, and a missing repo has its own code.
pub(crate) fn check(res: &GitResult, what: &str) -> Result<(), OpError> {
    if res.truncated || matches!(res.code, Some(0 | 1)) {
        return Ok(());
    }
    if res.stderr.to_ascii_lowercase().contains("not a git repository") {
        return Err(not_a_repo());
    }
    let code = res.code.map_or_else(|| "killed".to_owned(), |c| c.to_string());
    Err(OpError::plain(format!("git {what} failed ({code}): {}", res.stderr.trim())))
}

pub(crate) fn not_a_repo() -> OpError {
    OpError::coded(DaemonErrorCode::NotAGitRepo, "not inside a git repository")
}

pub(crate) fn stdout_text(res: &GitResult) -> String {
    String::from_utf8_lossy(&res.stdout).into_owned()
}

/// Porcelain v2 with -z: every record is NUL-terminated and a rename's original path follows as its own record
/// instead of a tab suffix.
pub(crate) fn parse_porcelain_v2(text: &str) -> (GitBranch, Vec<GitStatusEntry>) {
    let mut branch = GitBranch { oid: String::new(), head: String::new(), upstream: None, ahead: 0, behind: 0 };
    let mut entries = Vec::new();
    let tokens: Vec<&str> = text.split('\0').collect();
    let count = |word: Option<&&str>| word.and_then(|w| w.get(1..)).and_then(|n| n.parse().ok()).unwrap_or(0);
    let path_from = |parts: &[&str], from: usize| parts.get(from..).unwrap_or_default().join(" ");
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.is_empty() {
            continue;
        }
        let parts: Vec<&str> = tok.split(' ').collect();
        let xy = || parts.get(1).copied().unwrap_or_default().to_owned();
        match &tok[..1] {
            "#" => match parts.get(1).copied() {
                Some("branch.oid") => branch.oid = parts.get(2).copied().unwrap_or_default().to_owned(),
                Some("branch.head") => branch.head = parts.get(2).copied().unwrap_or_default().to_owned(),
                Some("branch.upstream") => branch.upstream = Some(parts.get(2).copied().unwrap_or_default().to_owned()),
                Some("branch.ab") => {
                    branch.ahead = count(parts.get(2));
                    branch.behind = count(parts.get(3));
                }
                _ => {}
            },
            "1" => entries.push(GitStatusEntry { xy: xy(), path: path_from(&parts, 8), orig_path: None }),
            "2" => {
                let orig_path = tokens.get(i).copied().unwrap_or_default().to_owned();
                i += 1;
                entries.push(GitStatusEntry { xy: xy(), path: path_from(&parts, 9), orig_path: Some(orig_path) });
            }
            "u" => entries.push(GitStatusEntry { xy: xy(), path: path_from(&parts, 10), orig_path: None }),
            kind @ ("?" | "!") => {
                entries.push(GitStatusEntry { xy: kind.repeat(2), path: tok.get(2..).unwrap_or_default().to_owned(), orig_path: None })
            }
            _ => {}
        }
    }
    (branch, entries)
}

pub(crate) async fn git_status<R: Runs>(runner: &R, cwd: &Path) -> Result<GitStatusReply, OpError> {
    let res = run_git(runner, cwd, &["status", "--porcelain=v2", "--branch", "--show-stash", "-z"], None, None).await?;
    check(&res, "status")?;
    let top = run_git(runner, cwd, &["rev-parse", "--show-toplevel"], None, None).await?;
    check(&top, "rev-parse")?;
    let (mut branch, entries) = parse_porcelain_v2(&stdout_text(&res));
    counted_without_upstream(runner, cwd, &mut branch).await?;
    let stashes = stashes_in(&stdout_text(&res));
    Ok(GitStatusReply { branch, entries, root: stdout_text(&top).trim().to_owned(), edits_unread: false, counts_unknown: false, stashes })
}

/// The `# stash N` header --show-stash adds, where the repository holds any.
fn stashes_in(porcelain: &str) -> Option<u64> {
    porcelain.split('\0').find_map(|tok| tok.strip_prefix("# stash ")?.trim().parse().ok()).filter(|n| *n > 0)
}

/// A branch with no upstream, or one whose tracking ref is gone, is counted against the default branch, as a
/// stopped copy's is: porcelain's 0 would read as nothing origin lacks.
async fn counted_without_upstream<R: Runs>(runner: &R, cwd: &Path, branch: &mut GitBranch) -> Result<(), OpError> {
    if branch.oid == "(initial)" {
        return Ok(());
    }
    if branch.upstream.is_some() {
        if rev_exists(runner, cwd, "@{upstream}").await? {
            return Ok(());
        }
        branch.upstream = None;
    }
    let Some(base) = default_branch(runner, cwd).await? else { return Ok(()) };
    let counted = run_git(runner, cwd, &["rev-list", "--left-right", "--count", &format!("{base}...HEAD")], None, None).await?;
    check(&counted, "rev-list")?;
    let text = stdout_text(&counted);
    let mut counts = text.split_whitespace().map(str::parse::<u64>);
    if let (Some(Ok(behind)), Some(Ok(ahead))) = (counts.next(), counts.next()) {
        (branch.ahead, branch.behind) = (ahead, behind);
        return Ok(());
    }
    Err(OpError::plain(format!("git rev-list answered {:?}", text.trim())))
}

pub(crate) async fn rev_exists<R: Runs>(runner: &R, cwd: &Path, rev: &str) -> Result<bool, OpError> {
    Ok(run_git(runner, cwd, &["rev-parse", "--verify", "-q", rev], None, None).await?.code == Some(0))
}

/// Where a branch's base is looked for, in order: origin's HEAD where a remote set it, else a local main or master.
/// Both roads read it, the running one through git and the stopped one off the files.
pub(crate) const DEFAULT_BRANCHES: [&str; 3] = ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"];

/// The first of those that names a commit here, by its short name. origin/HEAD counts only where the branch it
/// names is still there: a remote that renamed its default branch and a prune leave it naming nothing.
pub(crate) async fn default_branch<R: Runs>(runner: &R, cwd: &Path) -> Result<Option<String>, OpError> {
    for name in DEFAULT_BRANCHES {
        if name.ends_with("/HEAD") {
            let named = run_git(runner, cwd, &["symbolic-ref", "-q", "--short", name], None, None).await?;
            check(&named, "symbolic-ref")?;
            let target = stdout_text(&named).trim().to_owned();
            if named.code == Some(0) && rev_exists(runner, cwd, &target).await? {
                return Ok(Some(target));
            }
        } else if rev_exists(runner, cwd, name).await? {
            return Ok(Some(name.trim_start_matches("refs/heads/").to_owned()));
        }
    }
    Ok(None)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ListedFile {
    pub(crate) path: String,
    pub(crate) orig_path: Option<String>,
    /// added, modified, deleted, renamed or copied; a deleted file has no contents to hash.
    pub(crate) kind: &'static str,
}

/// git's status letter as the word a client draws it by.
fn kind_of(status: &str) -> &'static str {
    match status.chars().next() {
        Some('A') => "added",
        Some('D') => "deleted",
        Some('R') => "renamed",
        Some('C') => "copied",
        _ => "modified",
    }
}

/// `diff --name-status -z`: a status record, then the path, and for a rename or a copy the new path after it.
pub(crate) fn parse_name_status(text: &str) -> Vec<ListedFile> {
    let mut files = Vec::new();
    let mut tokens = text.split('\0');
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            continue;
        }
        let first = tokens.next().unwrap_or_default().to_owned();
        let kind = kind_of(status);
        if status.starts_with('R') || status.starts_with('C') {
            files.push(ListedFile { path: tokens.next().unwrap_or_default().to_owned(), orig_path: Some(first), kind });
        } else {
            files.push(ListedFile { path: first, orig_path: None, kind });
        }
    }
    files
}

/// `diff --numstat -z`: lines added and removed by the path they land at. A rename's record ends its counts with a
/// tab and names the old path and the new one as two more records; a binary file counts "-", which is none.
pub(crate) fn parse_numstat(text: &str) -> std::collections::HashMap<String, (u32, u32)> {
    let mut counts = std::collections::HashMap::new();
    let mut tokens = text.split('\0');
    while let Some(record) = tokens.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = tokens.next();
            tokens.next().unwrap_or_default().to_owned()
        } else {
            path.to_owned()
        };
        counts.insert(path, (added.parse().unwrap_or(0), removed.parse().unwrap_or(0)));
    }
    counts
}

/// The head of bytes that fits the limit, cut at the last line end inside it when there is one.
pub(crate) fn cut_at_line(bytes: &[u8], limit: usize) -> &[u8] {
    if bytes.len() <= limit {
        return bytes;
    }
    let head = &bytes[..limit];
    match head.iter().rposition(|b| *b == b'\n') {
        Some(nl) if nl > 0 => &head[..=nl],
        _ => head,
    }
}

/// The tree git calls empty, which a checkout with no commit yet diffs against in place of HEAD.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Every line of context git will give, so a patch holds its whole file.
const WHOLE: &str = "-U999999";

/// One name-status pass picks the files (so renames stay renames), then one diff per file spends a shared byte
/// budget; a file past the budget is still listed with an empty patch so the client knows it changed. path narrows
/// relative to cwd and paths names files from the top; per-file pathspecs use :(top) because git reports names from
/// the repo root whatever cwd is. The head and branch scopes add every untracked file as a new one, over the whole
/// repository as the listing is unless narrowed, and each file that still has contents carries the blob id they hash
/// to, one hash-object for them all. An untracked link is listed with no patch and no blob: a diff against /dev/null
/// takes a link to a folder for the folder and reads <folder>/null through it, and hash-object refuses one outright.
/// A repository whose top sits above bound, the folder the caller may read, answers for the files inside bound alone:
/// both listings take bound as their pathspec, and whatever a narrowing names outside it is dropped.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_diff<R: Runs>(
    runner: &R,
    cwd: &Path,
    bound: &Path,
    scope: GitDiffScope,
    path: Option<&str>,
    paths: &[String],
    whole: bool,
    cap: usize,
) -> Result<GitDiffReply, OpError> {
    let mut args: Vec<String> = Vec::new();
    let mut base = None;
    match scope {
        GitDiffScope::Staged => args.push("--cached".to_owned()),
        GitDiffScope::Branch => {
            base = default_branch(runner, cwd).await?;
            match &base {
                None => args.push("HEAD".to_owned()),
                Some(base) => {
                    let mb = run_git(runner, cwd, &["merge-base", base, "HEAD"], None, None).await?;
                    check(&mb, "merge-base")?;
                    args.push(if mb.code == Some(0) { stdout_text(&mb).trim().to_owned() } else { "HEAD".to_owned() });
                }
            }
        }
        GitDiffScope::Unstaged => {}
        GitDiffScope::Head => args.push(if rev_exists(runner, cwd, "HEAD").await? { "HEAD" } else { EMPTY_TREE }.to_owned()),
    }
    let listing = Listing {
        untracked: matches!(scope, GitDiffScope::Head | GitDiffScope::Branch),
        blobs: true,
        whole,
        worktree: scope != GitDiffScope::Staged,
    };
    diff_listed(runner, cwd, bound, &args, path, paths, listing, cap, base).await
}

/// The diff between two commits a git.snapshot recorded, held to bound as git.diff is. Each is taken only as its full
/// sha, which the caller has checked, so neither reaches git as an option.
pub(crate) async fn git_range<R: Runs>(
    runner: &R,
    cwd: &Path,
    bound: &Path,
    from: &str,
    to: &str,
    path: Option<&str>,
    cap: usize,
) -> Result<GitDiffReply, OpError> {
    for sha in [from, to] {
        let spec = format!("{sha}^{{commit}}");
        let held = run_git(runner, cwd, &["cat-file", "-e", &spec], None, None).await?;
        if held.code != Some(0) {
            if held.stderr.to_ascii_lowercase().contains("not a git repository") {
                return Err(not_a_repo());
            }
            return Err(OpError::coded(DaemonErrorCode::NotFound, format!("the snapshot {sha} is gone")));
        }
    }
    let listing = Listing { untracked: false, blobs: false, whole: false, worktree: false };
    diff_listed(runner, cwd, bound, &[from.to_owned(), to.to_owned()], path, &[], listing, cap, None).await
}

/// What a diff lists beyond git's own name-status: the untracked files as new ones, each file's worktree blob, and
/// whole files in one hunk.
#[derive(Clone, Copy)]
struct Listing {
    untracked: bool,
    blobs: bool,
    whole: bool,
    /// The post-image is the worktree, which git reads at whatever stands at each path, so a swap can point it
    /// outside the root. Every worktree file is then read on this side instead and its hunk built from that read.
    worktree: bool,
}

/// The blob id git names `bytes` by at `path`, the repository's own hash over them after its attributes for that
/// path, written into the object store so a tracked file's hunk can be diffed from it. A hash-object that fails
/// leaves the file without one, which is a file that cannot be marked viewed, never a diff that cannot be read.
/// Called once per tracked file whose worktree hunk `rebuilt_patch` diffs from the object, never per untracked file:
/// a checkout with tens of thousands of untracked files would spawn one git and write one loose object for each.
async fn written_blob<R: Runs>(runner: &R, top: &Path, path: &str, bytes: &[u8]) -> Result<Option<String>, OpError> {
    let res = run_git(runner, top, &["hash-object", "-w", "--stdin", "--path", path], Some(bytes), None).await?;
    let id = stdout_text(&res).trim().to_owned();
    Ok((res.code == Some(0) && !id.is_empty()).then_some(id))
}

/// The object format a repository names its blobs in; sha1 unless it was made with `--object-format=sha256`.
enum ObjectFormat {
    Sha1,
    Sha256,
}

/// Read from the repository, never inferred: a format wrong by a byte hashes every blob wrong, so anything but the
/// two git names, or a call that failed, fails the op rather than falling back to sha1.
async fn object_format<R: Runs>(runner: &R, cwd: &Path) -> Result<ObjectFormat, OpError> {
    let res = run_git(runner, cwd, &["rev-parse", "--show-object-format"], None, None).await?;
    check(&res, "rev-parse --show-object-format")?;
    match stdout_text(&res).trim() {
        "sha1" => Ok(ObjectFormat::Sha1),
        "sha256" => Ok(ObjectFormat::Sha256),
        other => Err(OpError::plain(format!("git names an object format this daemon cannot hash: {other:?}"))),
    }
}

/// The blob id git names `bytes` by, hashed here in this daemon's own process: the repository's hash over the git
/// object header `blob <len>\0` and the bytes. No git process is spawned and nothing is written, so a folder of
/// untracked files costs one hash each and no loose objects. The id is over the bytes as this side read them, which
/// is git's own where no attribute rewrites the file; the blob only marks a file viewed, and an untracked file has
/// no committed side an attribute could disagree with.
fn read_blob(format: &ObjectFormat, bytes: &[u8]) -> String {
    let header = format!("blob {}\0", bytes.len());
    let hex = |digest: &[u8]| digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
    match format {
        ObjectFormat::Sha1 => {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(header.as_bytes());
            h.update(bytes);
            hex(&h.finalize())
        }
        ObjectFormat::Sha256 => {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(header.as_bytes());
            h.update(bytes);
            hex(&h.finalize())
        }
    }
}

/// How long git writes a blob id in this repository's patches: as long as it cuts HEAD to, which grows with the
/// objects it holds, and seven where nothing is committed yet.
async fn abbrev_of<R: Runs>(runner: &R, cwd: &Path) -> Result<usize, OpError> {
    let res = run_git(runner, cwd, &["rev-parse", "--short", "HEAD"], None, None).await?;
    let short = stdout_text(&res).trim().len();
    Ok(if res.code == Some(0) && short >= 4 { short } else { 7 })
}

/// A tracked worktree file's patch, built so no content byte comes from git's own read of the worktree: git's diff
/// gives the header (the paths, the mode, a rename and its score), and the hunk body is a diff of two objects this
/// daemon holds, the base blob from history and `dst`, the blob hashed from this side's one read. So a file, or a
/// folder above it, swapped for a link after git listed it changes nothing in the reply. None where the base cannot
/// be read off git's header, which then leaves the file listed with no patch.
async fn rebuilt_patch<R: Runs>(
    runner: &R,
    cwd: &Path,
    git_worktree: &[u8],
    dst: &str,
    abbrev: usize,
    whole: bool,
    cap: usize,
) -> Result<Option<Vec<u8>>, OpError> {
    let Some(cut) = body_start(git_worktree) else {
        // No hunk and no binary line: a rename or a mode change with no content, whose header git read from the
        // objects and the stat, not from the worktree's bytes.
        return Ok(Some(git_worktree.to_vec()));
    };
    let header = &git_worktree[..cut];
    let Some(base) = index_pre_image(header) else { return Ok(None) };
    let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
    if whole {
        args.push(WHOLE);
    }
    args.extend([base, dst]);
    let res = run_git(runner, cwd, &args, None, Some(cap)).await?;
    check(&res, "diff")?;
    let mut out = with_post_image(header, dst, abbrev);
    match body_of(&res.stdout) {
        Some(Body::Binary) => out.extend(binary_line(header)),
        Some(Body::Text(hunks)) => out.extend_from_slice(hunks),
        None => {}
    }
    Ok(Some(out))
}

/// Whether git's worktree diff is of a file added in this scope, which has no pre-image object to diff its worktree
/// read against and is built as a new file instead.
fn is_added(patch: &[u8]) -> bool {
    patch.split(|&b| b == b'\n').take_while(|line| !line.starts_with(b"@@ ")).any(|line| line.starts_with(b"new file mode "))
}

/// Whether git's diff is of a file deleted in this scope, whose post-image is /dev/null so no worktree byte was read
/// for it: its header says so, and a modification a swap slipped in its place does not.
fn is_deletion(patch: &[u8]) -> bool {
    patch.split(|&b| b == b'\n').take_while(|line| !line.starts_with(b"@@ ")).any(|line| line.starts_with(b"deleted file mode "))
}

/// Where a worktree diff's body begins, which is what a swap can point git at: the first hunk or the one binary line.
/// None where the diff is a header alone.
fn body_start(patch: &[u8]) -> Option<usize> {
    let mut at = 0;
    for line in patch.split_inclusive(|&b| b == b'\n') {
        if line.starts_with(b"@@ ") || line.starts_with(b"Binary files ") {
            return Some(at);
        }
        at += line.len();
    }
    None
}

/// The base blob id off an `index <base>..<post> <mode>` line, the pre-image git read from its objects and not from
/// the worktree.
fn index_pre_image(header: &[u8]) -> Option<&str> {
    header
        .split(|&b| b == b'\n')
        .find_map(|line| line.strip_prefix(b"index "))
        .and_then(|rest| std::str::from_utf8(rest).ok())
        .and_then(|rest| rest.split("..").next())
        .map(str::trim)
        .filter(|base| !base.is_empty())
}

/// The header with the post-image of its `index` line set to `dst`, this side's own blob, in place of the one git
/// hashed from the worktree.
fn with_post_image(header: &[u8], dst: &str, abbrev: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(header.len());
    for line in header.split_inclusive(|&b| b == b'\n') {
        if let Some((pre, tail)) =
            line.strip_prefix(b"index ").and_then(|r| std::str::from_utf8(r).ok()).and_then(|r| r.trim_end().split_once(".."))
        {
            let mode = tail.split_whitespace().nth(1).map(|m| format!(" {m}")).unwrap_or_default();
            out.extend(format!("index {}..{}{}\n", pre.trim(), &dst[..abbrev.min(dst.len())], mode).into_bytes());
        } else {
            out.extend_from_slice(line);
        }
    }
    out
}

/// The one line git prints for a binary change, named by the paths in `header` rather than by the object ids the
/// blob-to-blob diff names.
fn binary_line(header: &[u8]) -> Vec<u8> {
    let names = header.split(|&b| b == b'\n').find_map(|line| line.strip_prefix(b"diff --git ")).unwrap_or(b"");
    let mut out = b"Binary files ".to_vec();
    out.extend_from_slice(names);
    out.extend_from_slice(b" differ\n");
    out
}

/// A blob-to-blob diff's body: the text hunks from the first `@@`, or that it is binary.
enum Body<'a> {
    Text(&'a [u8]),
    Binary,
}

fn body_of(patch: &[u8]) -> Option<Body<'_>> {
    let start = body_start(patch)?;
    if patch[start..].starts_with(b"Binary files ") {
        Some(Body::Binary)
    } else {
        Some(Body::Text(&patch[start..]))
    }
}

/// One name-status pass picks the files and one numstat pass counts them, then one diff per file spends the budget.
#[allow(clippy::too_many_arguments)]
async fn diff_listed<R: Runs>(
    runner: &R,
    cwd: &Path,
    bound: &Path,
    args: &[String],
    path: Option<&str>,
    paths: &[String],
    Listing { untracked: with_untracked, blobs: with_blobs, whole, worktree }: Listing,
    cap: usize,
    base: Option<String>,
) -> Result<GitDiffReply, OpError> {
    let top = run_git(runner, cwd, &["rev-parse", "--show-toplevel"], None, None).await?;
    check(&top, "rev-parse")?;
    let top = PathBuf::from(stdout_text(&top).trim());
    // Bound's own path from the top where the top sits above it: the prefix every answered path must carry.
    let within = match bound.strip_prefix(&top) {
        _ if crate::paths::is_inside(bound, &top) => None,
        Ok(rel) => Some(rel.to_string_lossy().into_owned()),
        Err(_) => return Err(crate::paths::outside_root(&cwd.to_string_lossy())),
    };
    let inside = |p: &str| within.as_deref().is_none_or(|w| p.strip_prefix(w).is_some_and(|rest| rest.starts_with('/')));
    let whole_bound = within.as_ref().map(|w| format!(":(top,literal){w}"));
    let named: Vec<String> = paths.iter().map(|p| format!(":(top,literal){p}")).collect();
    let narrowed: Vec<&str> = match path {
        _ if !named.is_empty() => named.iter().map(String::as_str).collect(),
        Some(path) => vec![path],
        None => whole_bound.iter().map(String::as_str).collect(),
    };
    // The object format is the repository's own, read before the listing so it is git's real answer, not one a link
    // swapped in over the top mid-read could turn into a failure; a broken answer here fails the diff.
    let format = if worktree && with_blobs { Some(object_format(runner, cwd).await?) } else { None };
    let mut list_args: Vec<&str> = vec!["diff"];
    list_args.extend(args.iter().map(String::as_str));
    list_args.extend(["-M", "--name-status", "-z"]);
    if !narrowed.is_empty() {
        list_args.push("--");
        list_args.extend(&narrowed);
    }
    let listed = run_git(runner, cwd, &list_args, None, None).await?;
    check(&listed, "diff --name-status")?;
    if listed.code != Some(0) {
        return Err(OpError::plain(format!("git diff --name-status failed: {}", listed.stderr.trim())));
    }
    let mut count_args: Vec<&str> = vec!["diff"];
    count_args.extend(args.iter().map(String::as_str));
    count_args.extend(["-M", "--numstat", "-z"]);
    if !narrowed.is_empty() {
        count_args.push("--");
        count_args.extend(&narrowed);
    }
    let counted = run_git(runner, cwd, &count_args, None, None).await?;
    check(&counted, "diff --numstat")?;
    let counts = parse_numstat(&stdout_text(&counted));
    let mut listed_files: Vec<(ListedFile, Untracked)> = parse_name_status(&stdout_text(&listed))
        .into_iter()
        .filter(|f| inside(&f.path))
        .map(|f| (ListedFile { orig_path: f.orig_path.filter(|o| inside(o)), ..f }, Untracked::No))
        .collect();
    if with_untracked {
        let mut others = vec!["ls-files", "--others", "--exclude-standard", "--eol", "--full-name", "-z", "--"];
        others.extend(if narrowed.is_empty() { vec![":/"] } else { narrowed.clone() });
        let untracked = run_git(runner, cwd, &others, None, None).await?;
        check(&untracked, "ls-files")?;
        // `--eol` leaves the worktree column, `w/`, empty for anything that is not a regular file.
        let text = stdout_text(&untracked);
        listed_files.extend(text.split('\0').filter_map(|row| row.split_once('\t')).filter(|(_, p)| inside(p)).map(|(eol, p)| {
            let regular = eol.split_whitespace().any(|w| w.starts_with("w/") && w.len() > 2);
            (
                ListedFile { path: p.to_owned(), orig_path: None, kind: "added" },
                if regular { Untracked::File } else { Untracked::NotRegular },
            )
        }));
    }
    // A worktree post-image is read on this side, from the folder the caller may read held open: the files' own
    // names below the top where the top sits inside it, or below that folder's place in the repository where it
    // sits above. Its blobs come from those reads, so blobs_of, which hashes worktree paths git could read through
    // a link, is left to the scopes whose post-image is an object (staged, a commit range).
    let held = if worktree { runner.on_this_side(bound) } else { None };
    let top_below: Option<String> = match (&within, worktree) {
        (Some(_), _) | (_, false) => None,
        (None, true) => {
            Some(top.strip_prefix(bound).map_err(|_| crate::paths::outside_root(&cwd.to_string_lossy()))?.to_string_lossy().into_owned())
        }
    };
    let below = |path: &str| -> Option<String> {
        match (&within, &top_below) {
            (Some(w), _) => path.strip_prefix(w.as_str()).and_then(|rest| rest.strip_prefix('/')).map(str::to_owned),
            (None, Some(t)) if t.is_empty() => Some(path.to_owned()),
            (None, Some(t)) => Some(format!("{t}/{path}")),
            (None, None) => None,
        }
    };
    let abbrev = if worktree { abbrev_of(runner, cwd).await? } else { 7 };
    let blobs = if with_blobs && !worktree {
        let hashed = listed_files.iter().filter(|(f, u)| f.kind != "deleted" && *u != Untracked::NotRegular).map(|(f, _)| f.path.as_str());
        blobs_of(runner, &top, hashed.collect()).await?
    } else {
        std::collections::HashMap::new()
    };
    let mut files = Vec::new();
    let mut remaining = cap;
    let mut truncated = false;
    for (file, untracked) in listed_files {
        let (additions, deletions) = counts.get(&file.path).copied().unwrap_or((0, 0));
        let bare = |path: String, kind: &str, blob: Option<String>| GitDiffFile {
            path,
            kind: kind.to_owned(),
            additions,
            deletions,
            patch: String::new(),
            blob,
        };
        if untracked == Untracked::NotRegular {
            files.push(bare(file.path, file.kind, None));
            continue;
        }
        // This side's own read of a worktree file, and the blob git names it by from that read: never git's read of
        // whatever stands at the path when it gets there.
        let seen = match (worktree && file.kind != "deleted", held.clone(), below(&file.path)) {
            (true, Some(at), Some(rel)) => crate::fs::blocking(move || Ok(untracked::seen(&at, &rel))).await?,
            _ => None,
        };
        // The blob id is hashed here from the bytes this side read, so a listing of many untracked files spawns no
        // git and writes no object; the object itself is written below only for the tracked hunks that diff from it.
        let mut blob = match (&seen, worktree, &format) {
            (Some(Seen::File { bytes, .. }), _, Some(format)) => Some(read_blob(format, bytes)),
            (_, false, _) => blobs.get(&file.path).cloned(),
            _ => None,
        };
        if matches!(seen, Some(Seen::TooLarge)) {
            truncated = true;
            files.push(bare(file.path, file.kind, None));
            continue;
        }
        if remaining == 0 {
            truncated = true;
            files.push(bare(file.path, file.kind, blob));
            continue;
        }
        let patch = if untracked == Untracked::File {
            // git listed it; this side reads and renders it, so a link swapped in after the listing is read as no
            // file rather than followed.
            let (Some(Seen::File { bytes, exec }), Some(dst)) = (&seen, blob.as_deref()) else {
                files.push(bare(file.path, file.kind, None));
                continue;
            };
            untracked::patch_of(&file.path, bytes, *exec, Some(dst), abbrev)
        } else {
            let specs: Vec<String> = file.orig_path.iter().chain([&file.path]).map(|p| format!(":(top,literal){p}")).collect();
            let mut diff_args: Vec<&str> = vec!["diff"];
            diff_args.extend(args.iter().map(String::as_str));
            diff_args.extend(["-M", "--no-color", "--no-ext-diff"]);
            if whole {
                diff_args.push(WHOLE);
            }
            diff_args.push("--");
            diff_args.extend(specs.iter().map(String::as_str));
            let res = run_git(runner, cwd, &diff_args, None, Some(remaining)).await?;
            check(&res, "diff")?;
            if !worktree {
                // The staged scope and a commit range diff objects, so git read no worktree bytes a swap could aim.
                if res.truncated {
                    truncated = true;
                }
                res.stdout
            } else if let Some(Seen::File { bytes, exec }) = &seen {
                // The post-image is the worktree: the header is git's, the hunk is built from this side's read.
                if is_added(&res.stdout) {
                    // A file added in this scope is rendered whole from the read, so its object is never needed.
                    let Some(dst) = blob.as_deref() else {
                        files.push(bare(file.path, file.kind, None));
                        continue;
                    };
                    untracked::patch_of(&file.path, bytes, *exec, Some(dst), abbrev)
                } else {
                    // The hunk diffs from the object, so this one tracked file's blob is written now and named by
                    // git's own id, which the repository's attributes may make differ from the read hash.
                    let Some(dst) = written_blob(runner, &top, &file.path, bytes).await? else {
                        files.push(bare(file.path, file.kind, None));
                        continue;
                    };
                    blob = Some(dst.clone());
                    match rebuilt_patch(runner, cwd, &res.stdout, &dst, abbrev, whole, remaining).await? {
                        Some(patch) => patch,
                        None => {
                            files.push(bare(file.path, file.kind, None));
                            continue;
                        }
                    }
                }
            } else if file.kind == "deleted" && is_deletion(&res.stdout) {
                // A deletion's post-image is /dev/null, so git read no worktree bytes; a name listed gone that a
                // swap made stand again reads back as a modification and is dropped here.
                if res.truncated {
                    truncated = true;
                }
                res.stdout
            } else {
                files.push(bare(file.path, file.kind, None));
                continue;
            }
        };
        let mut bytes = patch.as_slice();
        if bytes.len() > remaining {
            truncated = true;
            bytes = cut_at_line(bytes, remaining);
            remaining = 0;
        } else {
            remaining -= bytes.len();
        }
        let patch = utf8_text(bytes, true);
        // numstat reads tracked files alone; an untracked one is all additions, counted off its own patch.
        let (additions, deletions) = match counts.get(&file.path) {
            Some(counted) => *counted,
            None if untracked == Untracked::File => (added_lines(&patch), 0),
            None => (0, 0),
        };
        files.push(GitDiffFile { path: file.path, kind: file.kind.to_owned(), additions, deletions, patch, blob });
    }
    Ok(GitDiffReply { base, files, truncated })
}

/// Whether a listed file is one git does not track yet, and if so whether it is a regular file or something else.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Untracked {
    No,
    File,
    /// A link, or a nested repository's folder: anything `--eol` reads no worktree contents for.
    NotRegular,
}

/// Whether a ref is a commit named by its full sha and nothing else.
pub(crate) fn is_full_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The checkout as it stands as one commit on top of HEAD, taken the way a checkpoint takes its tree: an index of
/// its own seeded from the checkout's, every change added to it, new files in and ignored ones out, written as a
/// tree and committed. The checkout's own index is never written, no ref is moved, and commit-tree runs no hook.
pub(crate) async fn git_snapshot<R: Runs>(runner: &R, cwd: &Path) -> Result<wsp_frames::GitSnapshotReply, OpError> {
    let top = checkpoint::top_of(runner, cwd).await?;
    let at = top.as_path();
    let tree = checkpoint::with_index(runner, at, |index| async move {
        let added = checkpoint::git_on(runner, at, &index, &["add", "-A"]).await?;
        checkpoint::ran(&added, "add")?;
        let written = checkpoint::git_on(runner, at, &index, &["write-tree"]).await?;
        checkpoint::ran(&written, "write-tree")?;
        Ok(stdout_text(&written).trim().to_owned())
    })
    .await?;
    let head = run_git(runner, at, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], None, None).await?;
    let parent = (head.code == Some(0)).then(|| stdout_text(&head).trim().to_owned());
    let mut commit_args = vec!["-c", "user.name=wsp", "-c", "user.email=wsp@localhost", "commit-tree", tree.as_str(), "-m", "wsp snapshot"];
    if let Some(parent) = parent.as_deref() {
        commit_args.extend(["-p", parent]);
    }
    let commit = run_git(runner, at, &commit_args, None, None).await?;
    checkpoint::ran(&commit, "commit-tree")?;
    Ok(wsp_frames::GitSnapshotReply { commit: stdout_text(&commit).trim().to_owned() })
}

/// The lines a patch adds, its file header left out.
fn added_lines(patch: &str) -> u32 {
    patch.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count() as u32
}

/// The blob id each file's worktree contents hash to, by path from the top, one hash-object for them all. A name
/// holding a line end cannot ride the one-per-line list and goes without, and a hash-object that fails leaves every
/// file without: a file with no id is one that cannot be marked viewed, never a diff that cannot be read.
async fn blobs_of<R: Runs>(runner: &R, top: &Path, paths: Vec<&str>) -> Result<std::collections::HashMap<String, String>, OpError> {
    let paths: Vec<&str> = paths.into_iter().filter(|p| !p.contains('\n')).collect();
    if paths.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let input = paths.iter().map(|p| format!("{p}\n")).collect::<String>();
    let res = run_git(runner, top, &["hash-object", "--stdin-paths"], Some(input.as_bytes()), None).await?;
    if res.code != Some(0) {
        return Ok(std::collections::HashMap::new());
    }
    let text = stdout_text(&res);
    Ok(paths.into_iter().zip(text.lines()).map(|(p, id)| (p.to_owned(), id.to_owned())).collect())
}

/// A way of running that records what it was asked and answers what a case told it to, for the cases that read
/// what the halves above hand a runner without a git, a gh or a workspace anywhere.
#[cfg(test)]
pub(crate) mod recorded {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use super::{GitResult, OnThisSide, Runs};
    use crate::paths::OpError;

    /// One call a way of running was asked to make: where it was to run, the program, its arguments and its stdin.
    #[derive(Clone)]
    pub(crate) struct Call {
        pub(crate) cwd: String,
        pub(crate) program: String,
        pub(crate) args: Vec<String>,
        pub(crate) stdin: Option<Vec<u8>>,
    }

    pub(crate) struct Recorded {
        pub(crate) calls: Mutex<Vec<Call>>,
        pub(crate) answers: Mutex<Vec<GitResult>>,
        pub(crate) has: Vec<String>,
    }

    impl Recorded {
        pub(crate) fn new(has: &[&str]) -> Recorded {
            Recorded { calls: Mutex::new(Vec::new()), answers: Mutex::new(Vec::new()), has: has.iter().map(|w| (*w).to_owned()).collect() }
        }

        /// What the next call answers with, in the order they are given.
        pub(crate) fn answering(self, answers: Vec<(i32, &str)>) -> Recorded {
            self.answering_said(answers.into_iter().map(|(code, out)| (code, out, "")).collect())
        }

        /// The same, for the cases that read what a program said on stderr as well as what it exited with.
        pub(crate) fn answering_said(self, answers: Vec<(i32, &str, &str)>) -> Recorded {
            *self.answers.lock().unwrap() = answers
                .into_iter()
                .map(|(code, out, err)| GitResult {
                    code: Some(code),
                    stdout: out.as_bytes().to_vec(),
                    stderr: err.to_owned(),
                    truncated: false,
                })
                .collect();
            self
        }

        pub(crate) fn asked(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Runs for Recorded {
        async fn run(
            &self,
            cwd: &Path,
            program: &str,
            args: &[&str],
            input: Option<&[u8]>,
            _max_bytes: Option<usize>,
        ) -> Result<GitResult, OpError> {
            self.calls.lock().unwrap().push(Call {
                cwd: cwd.to_string_lossy().into_owned(),
                program: program.to_owned(),
                args: args.iter().map(|a| (*a).to_owned()).collect(),
                stdin: input.map(<[u8]>::to_vec),
            });
            let mut answers = self.answers.lock().unwrap();
            Ok(if answers.is_empty() {
                GitResult { code: Some(0), stdout: Vec::new(), stderr: String::new(), truncated: false }
            } else {
                answers.remove(0)
            })
        }

        async fn on_path(&self, program: &str) -> Result<bool, OpError> {
            Ok(self.has.iter().any(|held| held == program))
        }

        fn on_this_side(&self, folder: &Path) -> Option<OnThisSide> {
            Some(OnThisSide { open: folder.to_path_buf(), walk: PathBuf::new() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::here::Here;
    use super::*;
    use wsp_frames::numbers;

    /// git as the daemon runs it on the computer it is, which is what every case below reads.
    fn here() -> Here {
        Here::new()
    }

    #[tokio::test]
    async fn every_git_call_carries_optional_locks_off_and_the_c_locale_and_runs_at_the_work_score() {
        let dir = tempfile::tempdir().unwrap();
        let alias = "!sh -c 'echo \"$GIT_OPTIONAL_LOCKS|$LC_ALL|$GIT_TERMINAL_PROMPT\"; cat /proc/self/oom_score_adj'";
        let res = run_git(&here(), dir.path(), &["-c", &format!("alias.probe={alias}"), "probe"], None, None).await.unwrap();
        assert_eq!((res.code, res.truncated), (Some(0), false), "{}", res.stderr);
        assert_eq!(String::from_utf8_lossy(&res.stdout), format!("0|C|0\n{}\n", numbers::WORK_OOM_SCORE_ADJ));
    }

    #[tokio::test]
    async fn stdout_past_the_cap_ends_git_and_says_so_while_stdin_reaches_it() {
        let dir = tempfile::tempdir().unwrap();
        let echo = "!sh -c 'cat; yes | head -c 200000'";
        let res = run_git(&here(), dir.path(), &["-c", &format!("alias.probe={echo}"), "probe"], Some(b"in\n"), Some(10)).await.unwrap();
        assert!(res.truncated);
        assert_eq!(res.code, None);
        assert!(res.stdout.starts_with(b"in\ny\n"), "{:?}", &res.stdout[..8]);
        let whole = run_git(&here(), dir.path(), &["-c", &format!("alias.probe={echo}"), "probe"], Some(b"in\n"), None).await.unwrap();
        assert_eq!((whole.code, whole.truncated, whole.stdout.len()), (Some(0), false, 200_003));
    }

    #[tokio::test]
    async fn outside_a_repo_the_refusal_has_its_code_and_other_failures_name_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let err = git_status(&here(), dir.path()).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NotAGitRepo), "not inside a git repository"));
        let boom = "!sh -c 'echo boom >&2; exit 3'";
        let res = run_git(&here(), dir.path(), &["-c", &format!("alias.probe={boom}"), "probe"], None, None).await.unwrap();
        let err = check(&res, "probe").unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (None, "git probe failed (3): boom"));
        let answered = run_git(&here(), dir.path(), &["-c", "alias.probe=!sh -c 'exit 1'", "probe"], None, None).await.unwrap();
        assert_eq!(check(&answered, "probe"), Ok(()));
    }

    fn entry(xy: &str, path: &str, orig: Option<&str>) -> GitStatusEntry {
        GitStatusEntry { xy: xy.to_owned(), path: path.to_owned(), orig_path: orig.map(str::to_owned) }
    }

    #[test]
    fn porcelain_v2_reads_the_branch_header_and_every_entry_kind() {
        let text = concat!(
            "# branch.oid 0123456789abcdef0123456789abcdef01234567\0",
            "# branch.head feature\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/index.ts\0",
            "1 A. N... 000000 100644 100644 0000 cccc staged.txt\0",
            "2 R. N... 100644 100644 100644 dddd dddd R100 docs.md\0README.md\0",
            "u UU N... 100644 100644 100644 100644 e1 e2 e3 both.txt\0",
            "? untracked.txt\0",
            "! ignored.log\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb with space.txt\0",
        );
        let (branch, entries) = parse_porcelain_v2(text);
        assert_eq!(
            branch,
            GitBranch {
                oid: "0123456789abcdef0123456789abcdef01234567".to_owned(),
                head: "feature".to_owned(),
                upstream: Some("origin/main".to_owned()),
                ahead: 2,
                behind: 1,
            }
        );
        assert_eq!(
            entries,
            vec![
                entry(".M", "src/index.ts", None),
                entry("A.", "staged.txt", None),
                entry("R.", "docs.md", Some("README.md")),
                entry("UU", "both.txt", None),
                entry("??", "untracked.txt", None),
                entry("!!", "ignored.log", None),
                entry(".M", "with space.txt", None),
            ]
        );
    }

    #[test]
    fn porcelain_v2_on_a_repo_without_commits_or_upstream_leaves_the_header_blank_and_the_counts_at_zero() {
        let (branch, entries) = parse_porcelain_v2("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(branch, GitBranch { oid: "(initial)".to_owned(), head: "main".to_owned(), upstream: None, ahead: 0, behind: 0 });
        assert!(entries.is_empty());
        let (blank, none) = parse_porcelain_v2("");
        assert_eq!(blank, GitBranch { oid: String::new(), head: String::new(), upstream: None, ahead: 0, behind: 0 });
        assert!(none.is_empty());
    }

    #[test]
    fn name_status_keeps_a_rename_and_a_copy_as_one_file_with_its_origin() {
        let files = parse_name_status("M\0src/index.ts\0R100\0README.md\0docs.md\0A\0staged.txt\0C075\0a.txt\0b.txt\0D\0gone.txt\0");
        assert_eq!(
            files,
            vec![
                ListedFile { path: "src/index.ts".to_owned(), orig_path: None, kind: "modified" },
                ListedFile { path: "docs.md".to_owned(), orig_path: Some("README.md".to_owned()), kind: "renamed" },
                ListedFile { path: "staged.txt".to_owned(), orig_path: None, kind: "added" },
                ListedFile { path: "b.txt".to_owned(), orig_path: Some("a.txt".to_owned()), kind: "copied" },
                ListedFile { path: "gone.txt".to_owned(), orig_path: None, kind: "deleted" },
            ]
        );
        assert!(parse_name_status("").is_empty());
        assert_eq!(parse_name_status("M\0"), vec![ListedFile { path: String::new(), orig_path: None, kind: "modified" }]);
    }

    #[test]
    fn numstat_counts_each_file_by_where_it_lands_a_rename_by_its_new_path_and_a_binary_as_none() {
        let counts = parse_numstat("3\t0\tNOTES.md\x001\t2\t\0README.md\0docs.md\0-\t-\tlogo.png\0");
        assert_eq!(counts.get("NOTES.md"), Some(&(3, 0)));
        assert_eq!(counts.get("docs.md"), Some(&(1, 2)));
        assert_eq!(counts.get("logo.png"), Some(&(0, 0)));
        assert_eq!(counts.len(), 3);
    }

    fn git_in(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
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

    /// A checkout on main whose one commit holds the files named, each holding its name on thirty lines.
    fn committed(files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git_in(dir.path(), &["init", "-q", "-b", "main"]);
        for file in files {
            let at = dir.path().join(file);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, (1..=30).map(|n| format!("{file} {n}\n")).collect::<String>()).unwrap();
        }
        git_in(dir.path(), &["add", "-A"]);
        git_in(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "first"]);
        dir
    }

    fn paths_of(reply: &GitDiffReply) -> Vec<&str> {
        reply.files.iter().map(|f| f.path.as_str()).collect()
    }

    const CAP: usize = 1024 * 1024;

    /// Real git, except the per-file worktree diff (the one with a `--` pathspec) answers a patch this test hands
    /// it, standing in for what git prints when it reads the worktree through a link swapped in mid-read. The
    /// blob-to-blob diff the rebuild runs (two object ids, no `--`) still reaches real git.
    struct ReadThrough {
        inner: Here,
        patch: String,
    }

    impl Runs for ReadThrough {
        async fn run(
            &self,
            cwd: &Path,
            program: &str,
            args: &[&str],
            input: Option<&[u8]>,
            max_bytes: Option<usize>,
        ) -> Result<GitResult, OpError> {
            if args.first() == Some(&"diff") && args.contains(&"--") {
                return Ok(GitResult { code: Some(0), stdout: self.patch.clone().into_bytes(), stderr: String::new(), truncated: false });
            }
            self.inner.run(cwd, program, args, input, max_bytes).await
        }

        async fn on_path(&self, program: &str) -> Result<bool, OpError> {
            self.inner.on_path(program).await
        }

        fn on_this_side(&self, folder: &Path) -> Option<OnThisSide> {
            self.inner.on_this_side(folder)
        }
    }

    /// Real git, with one path swapped for a link to an outside folder the moment the listing it names answers.
    struct Swapping {
        inner: Here,
        swapped: PathBuf,
        outside: PathBuf,
        after: fn(&[&str]) -> bool,
    }

    fn tracked_listing(args: &[&str]) -> bool {
        args.first() == Some(&"diff") && args.contains(&"--name-status")
    }

    impl Swapping {
        fn untracked(swapped: PathBuf, outside: PathBuf) -> Swapping {
            Swapping { inner: here(), swapped, outside, after: |a| a.first() == Some(&"ls-files") }
        }
        fn undo(&self) {
            std::fs::remove_file(&self.swapped).unwrap();
            std::fs::rename(self.swapped.with_extension("aside"), &self.swapped).unwrap();
        }
    }

    impl Runs for Swapping {
        async fn run(
            &self,
            cwd: &Path,
            program: &str,
            args: &[&str],
            input: Option<&[u8]>,
            max_bytes: Option<usize>,
        ) -> Result<GitResult, OpError> {
            let res = self.inner.run(cwd, program, args, input, max_bytes).await;
            if (self.after)(args) && !self.swapped.is_symlink() {
                std::fs::rename(&self.swapped, self.swapped.with_extension("aside")).unwrap();
                std::os::unix::fs::symlink(&self.outside, &self.swapped).unwrap();
            }
            res
        }
        async fn on_path(&self, program: &str) -> Result<bool, OpError> {
            self.inner.on_path(program).await
        }
        fn on_this_side(&self, folder: &Path) -> Option<OnThisSide> {
            self.inner.on_this_side(folder)
        }
    }

    #[tokio::test]
    async fn an_untracked_file_or_folder_swapped_for_a_link_after_the_listing_is_never_read_through() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("a.txt"), "OUTSIDE-SECRET\n").unwrap();
        std::fs::write(outside.path().join("null"), "NULL-SECRET\n").unwrap();
        let dir = committed(&["kept.txt"]);
        std::fs::create_dir_all(dir.path().join("dir")).unwrap();
        std::fs::write(dir.path().join("dir/a.txt"), "inside\n").unwrap();
        std::fs::write(dir.path().join("caf\u{e9}"), "inside\n").unwrap();
        for (swapped, path) in [("dir", "dir/a.txt"), ("caf\u{e9}", "caf\u{e9}")] {
            let runner = Swapping::untracked(dir.path().join(swapped), outside.path().to_path_buf());
            let reply =
                git_diff(&runner, dir.path(), Path::new("/"), GitDiffScope::Head, None, &[path.to_owned()], false, CAP).await.unwrap();
            let said = format!("{:?}", reply.files);
            assert!(!said.contains("SECRET"), "{said}");
            assert_eq!((reply.files[0].patch.as_str(), reply.files[0].blob.as_deref()), ("", None), "{said}");
            runner.undo();
        }
    }

    #[tokio::test]
    async fn a_repository_whose_top_turns_into_a_link_after_the_listing_is_not_read_through_it() {
        let bound = tempfile::tempdir().unwrap();
        let bound = bound.path().canonicalize().unwrap();
        let repo = bound.join("sub");
        std::fs::create_dir_all(&repo).unwrap();
        git_in(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "inside\n").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("a.txt"), "OUTSIDE-SECRET\n").unwrap();
        let runner = Swapping::untracked(repo.clone(), outside.path().to_path_buf());
        let reply = git_diff(&runner, &repo, &bound, GitDiffScope::Head, None, &[], false, CAP).await.unwrap();
        let said = format!("{:?}", reply.files);
        assert!(!said.contains("SECRET"), "{said}");
        assert_eq!((reply.files[0].patch.as_str(), reply.files[0].blob.as_deref()), ("", None), "{said}");
    }

    #[tokio::test]
    async fn a_tracked_file_or_its_folder_swapped_after_the_listing_carries_nothing_read_through_the_link() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("t.txt"), "OUTSIDE-SECRET\n").unwrap();
        let outside_blob = git_in(outside.path(), &["hash-object", "t.txt"]).trim().to_owned();
        let dir = committed(&["dir/t.txt", "t.txt"]);
        std::fs::write(dir.path().join("dir/t.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("t.txt"), "changed\n").unwrap();
        for (swapped, path, to) in [("dir", "dir/t.txt", outside.path().to_path_buf()), ("t.txt", "t.txt", outside.path().join("t.txt"))] {
            let runner = Swapping { inner: here(), swapped: dir.path().join(swapped), outside: to, after: tracked_listing };
            let reply =
                git_diff(&runner, dir.path(), Path::new("/"), GitDiffScope::Head, None, &[path.to_owned()], false, CAP).await.unwrap();
            let said = format!("{:?}", reply.files);
            assert!(!said.contains("SECRET") && !said.contains(&outside_blob), "{said}");
            runner.undo();
        }
    }

    /// Isolates git's worktree body on its own, the shape the attributes hole let through: an eol rule makes the old
    /// line check stand down, and git's diff carries outside content under an index line whose post-image is the
    /// honest blob. The reply's hunk must be this side's own read.
    #[tokio::test]
    async fn a_worktree_files_hunk_is_this_sides_read_even_when_gits_body_names_the_honest_blob() {
        let dir = committed(&["t.txt"]);
        std::fs::write(dir.path().join(".gitattributes"), "*.txt text eol=lf\n").unwrap();
        git_in(dir.path(), &["add", ".gitattributes"]);
        git_in(dir.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "attributes"]);
        std::fs::write(dir.path().join("t.txt"), "changed\r\n").unwrap();
        let old = git_in(dir.path(), &["rev-parse", "HEAD:t.txt"]).trim().to_owned();
        let inside = git_in(dir.path(), &["hash-object", "t.txt"]).trim().to_owned();
        let patch = format!(
            "diff --git a/t.txt b/t.txt\nindex {}..{} 100644\n--- a/t.txt\n+++ b/t.txt\n@@ -1,2 +1 @@\n-one\n-two\n+OUTSIDE-SECRET\n",
            &old[..7],
            &inside[..7]
        );
        let runner = ReadThrough { inner: here(), patch };
        let reply = git_diff(&runner, dir.path(), Path::new("/"), GitDiffScope::Head, None, &[], true, CAP).await.unwrap();
        let said = format!("{:?}", reply.files);
        assert!(!said.contains("OUTSIDE-SECRET"), "{said}");
        assert!(reply.files[0].patch.contains("+changed"), "{said}");
        assert_eq!(reply.files[0].blob.as_deref(), Some(inside.as_str()), "{said}");
    }

    /// Real git, counting the hash-object processes it is asked to spawn.
    struct Counting {
        inner: Here,
        hashes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Runs for Counting {
        async fn run(
            &self,
            cwd: &Path,
            program: &str,
            args: &[&str],
            input: Option<&[u8]>,
            max_bytes: Option<usize>,
        ) -> Result<GitResult, OpError> {
            if args.first() == Some(&"hash-object") {
                self.hashes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            self.inner.run(cwd, program, args, input, max_bytes).await
        }
        async fn on_path(&self, program: &str) -> Result<bool, OpError> {
            self.inner.on_path(program).await
        }
        fn on_this_side(&self, folder: &Path) -> Option<OnThisSide> {
            self.inner.on_this_side(folder)
        }
    }

    #[tokio::test]
    async fn many_untracked_files_cost_no_hash_object_spawn_and_carry_the_blob_git_names() {
        let dir = committed(&["kept.txt"]);
        let mut names: Vec<String> = (0..40).map(|i| format!("u{i}.txt")).collect();
        for name in &names {
            std::fs::write(dir.path().join(name), format!("file {name}\n")).unwrap();
        }
        // An empty file and an executable one hash by content alone: read_blob is git's over zero bytes and over a
        // file the mode bit does not touch, so both are named the same as git names them.
        std::fs::write(dir.path().join("empty.txt"), "").unwrap();
        names.push("empty.txt".to_owned());
        let run = dir.path().join("run.sh");
        std::fs::write(&run, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::set_permissions(&run, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        names.push("run.sh".to_owned());

        let objects = || git_in(dir.path(), &["count-objects"]).split_whitespace().next().unwrap_or_default().to_owned();
        let before = objects();
        let hashes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let runner = Counting { inner: here(), hashes: hashes.clone() };
        let reply = git_diff(&runner, dir.path(), Path::new("/"), GitDiffScope::Head, None, &[], false, CAP).await.unwrap();
        assert_eq!(reply.files.len(), names.len());
        // Not one git hash-object was spawned for any untracked file, and no loose object was written.
        assert_eq!(hashes.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(objects(), before);
        // Every blob id is the one git would name the file by, the empty and the executable one included.
        for name in &names {
            let file = reply.files.iter().find(|f| &f.path == name).unwrap();
            assert_eq!(file.blob.as_deref(), Some(git_in(dir.path(), &["hash-object", name]).trim()), "{name}");
        }
    }

    #[tokio::test]
    async fn an_untracked_files_blob_is_git_s_in_a_sha1_and_a_sha256_repo() {
        let dir = committed(&["kept.txt"]);
        std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
        let reply =
            git_diff(&here(), dir.path(), Path::new("/"), GitDiffScope::Head, None, &["new.txt".to_owned()], false, CAP).await.unwrap();
        assert_eq!(reply.files[0].blob.as_deref(), Some(git_in(dir.path(), &["hash-object", "new.txt"]).trim()));

        let sha256 = tempfile::tempdir().unwrap();
        git_in(sha256.path(), &["init", "-q", "--object-format=sha256", "-b", "main"]);
        git_in(sha256.path(), &["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"]);
        std::fs::write(sha256.path().join("new.txt"), "fresh\n").unwrap();
        let reply = git_diff(&here(), sha256.path(), Path::new("/"), GitDiffScope::Head, None, &[], false, CAP).await.unwrap();
        assert_eq!(reply.files[0].blob.as_deref(), Some(git_in(sha256.path(), &["hash-object", "new.txt"]).trim()));
    }

    #[tokio::test]
    async fn an_untracked_file_past_the_read_cap_is_listed_with_no_patch_and_no_blob() {
        let dir = committed(&["kept.txt"]);
        std::fs::File::create(dir.path().join("huge.bin")).unwrap().set_len(untracked::READ_MAX as u64 + 1).unwrap();
        let hashes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let runner = Counting { inner: here(), hashes: hashes.clone() };
        let reply =
            git_diff(&runner, dir.path(), Path::new("/"), GitDiffScope::Head, None, &["huge.bin".to_owned()], false, CAP).await.unwrap();
        assert_eq!((reply.files[0].patch.as_str(), reply.files[0].blob.as_deref()), ("", None));
        assert!(reply.truncated);
        // A file past the cap is never read to the end and never hashed, in process or out.
        assert_eq!(hashes.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    /// Real git, but the object format it names is whatever the test hands back.
    struct Formatted {
        inner: Here,
        says: &'static str,
    }

    impl Runs for Formatted {
        async fn run(
            &self,
            cwd: &Path,
            program: &str,
            args: &[&str],
            input: Option<&[u8]>,
            max_bytes: Option<usize>,
        ) -> Result<GitResult, OpError> {
            if args.first() == Some(&"rev-parse") && args.get(1) == Some(&"--show-object-format") {
                return Ok(GitResult { code: Some(0), stdout: self.says.as_bytes().to_vec(), stderr: String::new(), truncated: false });
            }
            self.inner.run(cwd, program, args, input, max_bytes).await
        }
        async fn on_path(&self, program: &str) -> Result<bool, OpError> {
            self.inner.on_path(program).await
        }
        fn on_this_side(&self, folder: &Path) -> Option<OnThisSide> {
            self.inner.on_this_side(folder)
        }
    }

    #[tokio::test]
    async fn an_object_format_that_is_not_git_s_two_fails_the_diff_rather_than_hashing_wrong() {
        let dir = committed(&["kept.txt"]);
        std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
        for says in ["", "sha512", "sha1\nextra"] {
            let runner = Formatted { inner: here(), says };
            let err = git_diff(&runner, dir.path(), Path::new("/"), GitDiffScope::Head, None, &[], false, CAP).await;
            assert!(err.is_err(), "object format {says:?} should fail the op, not fall back to sha1");
        }
    }

    #[tokio::test]
    async fn the_head_scope_folds_staged_and_unstaged_edits_and_lists_each_untracked_file_as_new() {
        let dir = committed(&["a.txt", "b.txt"]);
        std::fs::write(dir.path().join("a.txt"), "staged\n").unwrap();
        git_in(dir.path(), &["add", "a.txt"]);
        std::fs::write(dir.path().join("b.txt"), "unstaged\n").unwrap();
        std::fs::create_dir_all(dir.path().join("new/deep")).unwrap();
        std::fs::write(dir.path().join("new/deep/c.txt"), "fresh\n").unwrap();
        let reply = git_diff(&here(), &dir.path().join("new"), Path::new("/"), GitDiffScope::Head, None, &[], false, CAP).await.unwrap();
        assert_eq!(paths_of(&reply), vec!["a.txt", "b.txt", "new/deep/c.txt"]);
        assert!(reply.files[0].patch.contains("+staged"), "{}", reply.files[0].patch);
        assert!(reply.files[1].patch.contains("+unstaged"), "{}", reply.files[1].patch);
        let fresh = &reply.files[2].patch;
        assert!(fresh.contains("new file mode") && fresh.contains("+++ b/new/deep/c.txt") && fresh.contains("+fresh"), "{fresh}");
    }

    #[tokio::test]
    async fn paths_narrow_the_diff_to_the_files_named_and_read_a_star_as_a_letter() {
        let dir = committed(&["a*b.txt", "aXb.txt", "other.txt"]);
        for file in ["a*b.txt", "aXb.txt", "other.txt"] {
            std::fs::write(dir.path().join(file), "changed\n").unwrap();
        }
        std::fs::write(dir.path().join("loose.txt"), "untracked\n").unwrap();
        let named = vec!["a*b.txt".to_owned(), "loose.txt".to_owned()];
        let reply = git_diff(&here(), dir.path(), Path::new("/"), GitDiffScope::Head, None, &named, false, CAP).await.unwrap();
        assert_eq!(paths_of(&reply), vec!["a*b.txt", "loose.txt"]);
    }

    #[tokio::test]
    async fn whole_gives_the_file_in_one_hunk() {
        let dir = committed(&["long.txt"]);
        let mut lines: Vec<String> = (1..=30).map(|n| format!("long.txt {n}")).collect();
        lines[1] = "second changed".to_owned();
        lines[28] = "twenty-ninth changed".to_owned();
        std::fs::write(dir.path().join("long.txt"), lines.join("\n") + "\n").unwrap();
        let split = git_diff(&here(), dir.path(), Path::new("/"), GitDiffScope::Head, None, &[], false, CAP).await.unwrap();
        assert_eq!(split.files[0].patch.matches("\n@@ ").count(), 2, "{}", split.files[0].patch);
        let whole = git_diff(&here(), dir.path(), Path::new("/"), GitDiffScope::Head, None, &[], true, CAP).await.unwrap();
        assert_eq!(whole.files[0].patch.matches("\n@@ ").count(), 1, "{}", whole.files[0].patch);
        assert!(whole.files[0].patch.contains(" long.txt 15\n"), "{}", whole.files[0].patch);
    }

    #[tokio::test]
    async fn each_file_carries_the_blob_of_its_worktree_contents_and_a_gone_one_carries_none() {
        let dir = committed(&["kept.txt", "gone.txt"]);
        std::fs::write(dir.path().join("kept.txt"), "changed\n").unwrap();
        std::fs::remove_file(dir.path().join("gone.txt")).unwrap();
        std::fs::write(dir.path().join("loose.txt"), "untracked\n").unwrap();
        let reply = git_diff(&here(), dir.path(), Path::new("/"), GitDiffScope::Head, None, &[], false, CAP).await.unwrap();
        let blob = |name: &str| reply.files.iter().find(|f| f.path == name).unwrap().blob.clone();
        let hashed = |name: &str| Some(git_in(dir.path(), &["hash-object", name]).trim().to_owned());
        assert_eq!(blob("kept.txt"), hashed("kept.txt"));
        assert_eq!(blob("loose.txt"), hashed("loose.txt"));
        assert_eq!(blob("gone.txt"), None);
    }

    #[test]
    fn the_budget_cuts_at_the_last_line_end_inside_it_and_leaves_short_output_alone() {
        assert_eq!(cut_at_line(b"one\ntwo\nthree\n", 100), b"one\ntwo\nthree\n");
        assert_eq!(cut_at_line(b"one\ntwo\nthree\n", 9), b"one\ntwo\n");
        assert_eq!(cut_at_line(b"one\ntwo\nthree\n", 8), b"one\ntwo\n");
        assert_eq!(cut_at_line(b"one\ntwo\nthree\n", 7), b"one\n");
        assert_eq!(cut_at_line(b"no line end here", 5), b"no li");
        assert_eq!(cut_at_line(b"\nabc", 2), b"\na");
    }
}
