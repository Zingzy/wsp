// SPDX-License-Identifier: AGPL-3.0-only
//! git through the git binary the guest carries, never a library: one parser of porcelain v2, and the diff pane's
//! shared byte budget.

use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use wsp_frames::{numbers, DaemonErrorCode, GitBranch, GitDiffFile, GitDiffReply, GitDiffScope, GitStatusEntry, GitStatusReply};

use crate::fs::utf8_text;
use crate::paths::OpError;

pub(crate) struct GitResult {
    /// None when a signal ended git, which is what the byte cap does.
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
    /// stdout passed the cap; git was killed and code is None.
    pub(crate) truncated: bool,
}

/// argv behind the work-score line, never interpolated into a shell: sh runs the line, then execs git in its own
/// place. GIT_OPTIONAL_LOCKS keeps status from touching the index; LC_ALL=C keeps the not-a-repo message matchable.
fn git_command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(format!("{}; exec \"$0\" \"$@\"", numbers::work_score_line()))
        .arg("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// Runs git with stdin fed then closed, stdout under an optional cap past which git is killed, stderr as text.
pub(crate) async fn run_git(cwd: &Path, args: &[&str], input: Option<&[u8]>, max_bytes: Option<usize>) -> Result<GitResult, OpError> {
    let mut command = git_command(cwd, args);
    let mut child = command.spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let feed = async {
        if let (Some(mut stdin), Some(bytes)) = (stdin, input) {
            let _ = stdin.write_all(bytes).await;
        }
    };
    let read_out = async {
        let mut collected = Vec::new();
        let mut truncated = false;
        if let Some(mut pipe) = stdout {
            let mut buf = vec![0u8; 64 * 1024];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                if truncated {
                    continue;
                }
                collected.extend_from_slice(&buf[..n]);
                if max_bytes.is_some_and(|cap| collected.len() > cap) {
                    truncated = true;
                    let _ = child.start_kill();
                }
            }
        }
        (collected, truncated)
    };
    let read_err = async {
        let mut collected = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut collected).await;
        }
        String::from_utf8_lossy(&collected).into_owned()
    };
    let ((), (stdout, truncated), stderr) = tokio::join!(feed, read_out, read_err);
    let status = child.wait().await?;
    Ok(GitResult { code: status.code(), stdout, stderr, truncated })
}

/// Exit 0 and 1 are answers, a cut is the cap's doing; anything else failed, and a missing repo has its own code.
fn check(res: &GitResult, what: &str) -> Result<(), OpError> {
    if res.truncated || matches!(res.code, Some(0 | 1)) {
        return Ok(());
    }
    if res.stderr.to_ascii_lowercase().contains("not a git repository") {
        return Err(OpError::coded(DaemonErrorCode::NotAGitRepo, "not inside a git repository"));
    }
    let code = res.code.map_or_else(|| "killed".to_owned(), |c| c.to_string());
    Err(OpError::plain(format!("git {what} failed ({code}): {}", res.stderr.trim())))
}

fn stdout_text(res: &GitResult) -> String {
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

pub(crate) async fn git_status(cwd: &Path) -> Result<GitStatusReply, OpError> {
    let res = run_git(cwd, &["status", "--porcelain=v2", "--branch", "-z"], None, None).await?;
    check(&res, "status")?;
    let top = run_git(cwd, &["rev-parse", "--show-toplevel"], None, None).await?;
    check(&top, "rev-parse")?;
    let (branch, entries) = parse_porcelain_v2(&stdout_text(&res));
    Ok(GitStatusReply { branch, entries, root: stdout_text(&top).trim().to_owned() })
}

async fn rev_exists(cwd: &Path, rev: &str) -> Result<bool, OpError> {
    Ok(run_git(cwd, &["rev-parse", "--verify", "-q", rev], None, None).await?.code == Some(0))
}

/// origin/HEAD when a remote set it, else a local main or master.
async fn default_branch(cwd: &Path) -> Result<Option<String>, OpError> {
    let remote = run_git(cwd, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], None, None).await?;
    check(&remote, "symbolic-ref")?;
    if remote.code == Some(0) {
        return Ok(Some(stdout_text(&remote).trim().to_owned()));
    }
    for name in ["main", "master"] {
        if rev_exists(cwd, &format!("refs/heads/{name}")).await? {
            return Ok(Some(name.to_owned()));
        }
    }
    Ok(None)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ListedFile {
    pub(crate) path: String,
    pub(crate) orig_path: Option<String>,
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
        if status.starts_with('R') || status.starts_with('C') {
            files.push(ListedFile { path: tokens.next().unwrap_or_default().to_owned(), orig_path: Some(first) });
        } else {
            files.push(ListedFile { path: first, orig_path: None });
        }
    }
    files
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

/// One name-status pass picks the files (so renames stay renames), then one diff per file spends a shared byte
/// budget; a file past the budget is still listed with an empty patch so the client knows it changed. path narrows
/// relative to cwd; per-file pathspecs use :(top) because git reports names from the repo root whatever cwd is.
pub(crate) async fn git_diff(cwd: &Path, scope: GitDiffScope, path: Option<&str>, cap: usize) -> Result<GitDiffReply, OpError> {
    let mut args: Vec<String> = Vec::new();
    let mut base = None;
    match scope {
        GitDiffScope::Staged => args.push("--cached".to_owned()),
        GitDiffScope::Branch => {
            base = default_branch(cwd).await?;
            match &base {
                None => args.push("HEAD".to_owned()),
                Some(base) => {
                    let mb = run_git(cwd, &["merge-base", base, "HEAD"], None, None).await?;
                    check(&mb, "merge-base")?;
                    args.push(if mb.code == Some(0) { stdout_text(&mb).trim().to_owned() } else { "HEAD".to_owned() });
                }
            }
        }
        GitDiffScope::Unstaged => {}
    }
    let mut list_args: Vec<&str> = vec!["diff"];
    list_args.extend(args.iter().map(String::as_str));
    list_args.extend(["-M", "--name-status", "-z"]);
    if let Some(path) = path {
        list_args.extend(["--", path]);
    }
    let listed = run_git(cwd, &list_args, None, None).await?;
    check(&listed, "diff --name-status")?;
    if listed.code != Some(0) {
        return Err(OpError::plain(format!("git diff --name-status failed: {}", listed.stderr.trim())));
    }
    let mut files = Vec::new();
    let mut remaining = cap;
    let mut truncated = false;
    for file in parse_name_status(&stdout_text(&listed)) {
        if remaining == 0 {
            truncated = true;
            files.push(GitDiffFile { path: file.path, patch: String::new() });
            continue;
        }
        let specs: Vec<String> = file.orig_path.iter().chain([&file.path]).map(|p| format!(":(top){p}")).collect();
        let mut diff_args: Vec<&str> = vec!["diff"];
        diff_args.extend(args.iter().map(String::as_str));
        diff_args.extend(["-M", "--no-color", "--no-ext-diff", "--"]);
        diff_args.extend(specs.iter().map(String::as_str));
        let res = run_git(cwd, &diff_args, None, Some(remaining)).await?;
        check(&res, "diff")?;
        let mut bytes = res.stdout.as_slice();
        if res.truncated || bytes.len() > remaining {
            truncated = true;
            bytes = cut_at_line(bytes, remaining);
            remaining = 0;
        } else {
            remaining -= bytes.len();
        }
        files.push(GitDiffFile { path: file.path, patch: utf8_text(bytes, true) });
    }
    Ok(GitDiffReply { base, files, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_is_argv_behind_the_work_score_line_with_optional_locks_off_and_the_c_locale() {
        let command = git_command(Path::new("/srv"), &["status", "--porcelain=v2"]);
        let std = command.as_std();
        assert_eq!(std.get_program(), "/bin/sh");
        let args: Vec<&str> = std.get_args().map(|a| a.to_str().unwrap()).collect();
        let line = format!("{}; exec \"$0\" \"$@\"", numbers::work_score_line());
        assert_eq!(args, ["-c", line.as_str(), "git", "status", "--porcelain=v2"]);
        let env: Vec<(String, Option<String>)> =
            std.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        for pair in [("GIT_OPTIONAL_LOCKS", "0"), ("GIT_TERMINAL_PROMPT", "0"), ("LC_ALL", "C")] {
            assert!(env.contains(&(pair.0.to_owned(), Some(pair.1.to_owned()))), "{env:?}");
        }
        assert_eq!(std.get_current_dir(), Some(Path::new("/srv")));
    }

    #[tokio::test]
    async fn every_git_call_carries_optional_locks_off_and_the_c_locale_and_runs_at_the_work_score() {
        let dir = tempfile::tempdir().unwrap();
        let alias = "!sh -c 'echo \"$GIT_OPTIONAL_LOCKS|$LC_ALL|$GIT_TERMINAL_PROMPT\"; cat /proc/self/oom_score_adj'";
        let res = run_git(dir.path(), &["-c", &format!("alias.probe={alias}"), "probe"], None, None).await.unwrap();
        assert_eq!((res.code, res.truncated), (Some(0), false), "{}", res.stderr);
        assert_eq!(String::from_utf8_lossy(&res.stdout), format!("0|C|0\n{}\n", numbers::WORK_OOM_SCORE_ADJ));
    }

    #[tokio::test]
    async fn stdout_past_the_cap_ends_git_and_says_so_while_stdin_reaches_it() {
        let dir = tempfile::tempdir().unwrap();
        let echo = "!sh -c 'cat; yes | head -c 200000'";
        let res = run_git(dir.path(), &["-c", &format!("alias.probe={echo}"), "probe"], Some(b"in\n"), Some(10)).await.unwrap();
        assert!(res.truncated);
        assert_eq!(res.code, None);
        assert!(res.stdout.starts_with(b"in\ny\n"), "{:?}", &res.stdout[..8]);
        let whole = run_git(dir.path(), &["-c", &format!("alias.probe={echo}"), "probe"], Some(b"in\n"), None).await.unwrap();
        assert_eq!((whole.code, whole.truncated, whole.stdout.len()), (Some(0), false, 200_003));
    }

    #[tokio::test]
    async fn outside_a_repo_the_refusal_has_its_code_and_other_failures_name_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let err = git_status(dir.path()).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NotAGitRepo), "not inside a git repository"));
        let boom = "!sh -c 'echo boom >&2; exit 3'";
        let res = run_git(dir.path(), &["-c", &format!("alias.probe={boom}"), "probe"], None, None).await.unwrap();
        let err = check(&res, "probe").unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (None, "git probe failed (3): boom"));
        let answered = run_git(dir.path(), &["-c", "alias.probe=!sh -c 'exit 1'", "probe"], None, None).await.unwrap();
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
                ListedFile { path: "src/index.ts".to_owned(), orig_path: None },
                ListedFile { path: "docs.md".to_owned(), orig_path: Some("README.md".to_owned()) },
                ListedFile { path: "staged.txt".to_owned(), orig_path: None },
                ListedFile { path: "b.txt".to_owned(), orig_path: Some("a.txt".to_owned()) },
                ListedFile { path: "gone.txt".to_owned(), orig_path: None },
            ]
        );
        assert!(parse_name_status("").is_empty());
        assert_eq!(parse_name_status("M\0"), vec![ListedFile { path: String::new(), orig_path: None }]);
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
