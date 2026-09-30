// SPDX-License-Identifier: AGPL-3.0-only
//! Pull requests through the git host's own signed-in command line, which is what the image, the box or the Mac
//! carries: wsp holds no token for a git host and speaks no host's API. One module per host, each saying which
//! program it runs, the argv for every ask and how to read that program's JSON; one registry keyed on the name the
//! remote's url carries. Adding GitLab is a module beside github.rs and one row in HOSTS.

use std::path::Path;

use wsp_frames::{
    numbers, words, DaemonErrorCode, GitBranchCompareReply, GitPrListReply, GitPrMergeReply, GitPrReply, GitPrViewReply, GitRepoReadReply,
    GitRunLogReply, HostItem, HostItemKind, MergeMethod, PullRequest, PullRequestCheck, PullRequestState,
};

use crate::git::Runs;
use crate::paths::OpError;

mod github;

/// Which pull request an ask is about: the one a branch has, or one by its number.
pub(crate) enum Pick<'a> {
    Branch(&'a str),
    Number(u64),
}

impl Pick<'_> {
    fn word(&self) -> String {
        match self {
            Pick::Branch(branch) => (*branch).to_owned(),
            Pick::Number(n) => n.to_string(),
        }
    }
}

/// One git host's command line, as data: what to run, what to run it with, and how to read what it answered. Every
/// line that reads names the repository itself, so none of them reads it off the folder it runs in.
pub(crate) trait PullRequests: Sync {
    /// The host name a remote's url carries for this module.
    fn host(&self) -> &'static str;
    /// The program every one of its lines runs, which is what a computer with no login for this host lacks.
    fn program(&self) -> &'static str;
    /// The line that answers with a pull request as JSON, and refuses where there is none.
    fn view_argv(&self, repo: &str, pick: &Pick<'_>) -> Vec<String>;
    /// The line that opens one. A title turns into the pull request's own title and body; without one the host
    /// fills both from the commits, which is what an agent's branch usually wants said.
    fn create_argv(&self, base: &str, branch: &str, title: Option<&str>, body: Option<&str>) -> Vec<String>;
    /// The pull request one of those lines answered with, off its JSON and never its prose, its checks and its count
    /// behind the base still to read; nothing where the JSON is not one this module reads.
    fn read(&self, stdout: &str) -> Option<PullRequest>;
    /// The line that answers with every check on a pull request's head.
    fn checks_argv(&self, repo: &str, number: u64) -> Vec<String>;
    fn read_checks(&self, stdout: &str) -> Option<Vec<PullRequestCheck>>;
    /// The line that answers with how many commits the base has that the head lacks, as a bare number.
    fn behind_argv(&self, repo: &str, base: &str, head_oid: &str) -> Vec<String>;
    /// The line that answers with how far one branch is from another, and the counts and word read off it: commits
    /// the head has that the base lacks, the other way, and the host's word for the two.
    fn compare_argv(&self, repo: &str, base: &str, head: &str) -> Vec<String>;
    fn read_compare(&self, stdout: &str) -> Option<(u64, u64, String)>;
    /// Whether a line refused because the host lacks what it named, off what the program said.
    fn not_found(&self, stderr: &str) -> bool;
    /// The two lines a pull request's page is read from: its own JSON, and the comments left on its lines.
    fn page_argv(&self, repo: &str, number: u64) -> Vec<String>;
    fn line_comments_argv(&self, repo: &str, number: u64) -> Vec<String>;
    fn read_page(&self, page: &str, line_comments: &str) -> Option<GitPrViewReply>;
    /// The line that prints the failed steps of one job of one run.
    fn log_argv(&self, repo: &str, run_id: u64, job_id: u64) -> Vec<String>;
    /// The line that merges, or arms a merge for when the checks pass, only while the head is the commit named.
    fn merge_argv(&self, repo: &str, number: u64, method: MergeMethod, auto: bool, head_oid: &str) -> Vec<String>;
    /// The line read after a merge, and what it says: merged, and armed to merge once the checks pass.
    fn merged_argv(&self, repo: &str, number: u64) -> Vec<String>;
    fn read_merged(&self, stdout: &str) -> Option<(bool, bool)>;
    /// The two lines a repository's merge settings are read from.
    fn repo_argv(&self, repo: &str) -> Vec<String>;
    fn auto_merge_argv(&self, repo: &str) -> Vec<String>;
    fn read_repo(&self, repo: &str, auto_merge: &str) -> Option<GitRepoReadReply>;
    /// The line that answers with the repository's open items of one kind as JSON, at most GIT_PR_LIST_CAP of them.
    fn list_argv(&self, kind: HostItemKind) -> Vec<String>;
    /// The items one of those lines answered with, off its JSON; nothing where the JSON is not one this module reads.
    fn read_list(&self, kind: HostItemKind, stdout: &str) -> Option<Vec<HostItem>>;
    /// The exit code that program answers with when it is there and nobody is signed in, where it has one of its
    /// own. Read off the code and not the sentence: a sentence is the program's to reword between releases.
    fn sign_in_exit(&self) -> Option<i32>;
    /// What gives this computer a git credential for the host, in the words of the one command only the person can
    /// run. Said beside a push refused for want of one; a host with no module here says none of it.
    fn credential_fix(&self) -> &'static str;
}

/// Every git host wsp knows a command line for.
const HOSTS: [&dyn PullRequests; 1] = [&github::GitHub];

/// The host name a remote's url carries: the authority of a url, or what stands before the colon in the scp form
/// every host also offers. A login and a port are no part of the name.
pub(crate) fn host_name(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();
    // A remote that is a folder is a remote with no host: a checkout pushed to a bare repository beside it has one.
    if url.starts_with('/') || url.starts_with('.') || url.starts_with('~') {
        return None;
    }
    let authority = match url.split_once("://") {
        Some((_, rest)) => rest.split(['/', ':']).next().unwrap_or_default(),
        None => url.split_once(':')?.0,
    };
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    (!host.is_empty() && host.contains('.')).then(|| host.to_ascii_lowercase())
}

/// The module for the host that remote lives on, or nothing where wsp knows no command line for it.
pub(crate) fn host_for(remote_url: &str) -> Option<&'static dyn PullRequests> {
    let name = host_name(remote_url)?;
    HOSTS.iter().copied().find(|h| h.host() == name)
}

/// The repository a remote's url names, `owner/repo`, off the scp form, an ssh url or an https one, a `.git` on
/// the end taken off; nothing for a url whose path is not exactly two parts.
pub(crate) fn repo_of(remote_url: &str) -> Option<String> {
    host_name(remote_url)?;
    let url = remote_url.trim();
    let path = match url.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?.1,
        None => url.split_once(':')?.1,
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    let plain = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (plain(owner) && plain(repo) && owner != "." && owner != ".." && repo != "." && repo != "..").then(|| format!("{owner}/{repo}"))
}

/// What one host call is made against: the folder the way of running runs it in, and the remote that says which
/// host and which repository it is. Where the command line is looked up and run is the runner's, not this ask's:
/// a workspace on a computer somebody owns runs its own gh, on its own PATH, inside itself, and the Mac's own
/// daemon runs the Mac's.
pub(crate) struct Ask<'a> {
    pub(crate) cwd: &'a Path,
    pub(crate) remote_url: &'a str,
}

/// The module and the repository for this ask, refused in one sentence where the host is unknown, the remote names
/// no repository, or the host's command line is not on the PATH the runner finds programs on: the three read the
/// same to a person, and a push has already landed either way.
async fn cli_for<R: Runs>(runner: &R, ask: &Ask<'_>) -> Result<(&'static dyn PullRequests, String), OpError> {
    let named = host_name(ask.remote_url).unwrap_or_else(|| ask.remote_url.to_owned());
    let refused = || OpError::coded(DaemonErrorCode::NoHostCli, words::no_host_cli(&named));
    let host = host_for(ask.remote_url).ok_or_else(refused)?;
    let repo = repo_of(ask.remote_url).ok_or_else(refused)?;
    if !runner.on_path(host.program()).await? {
        return Err(refused());
    }
    Ok((host, repo))
}

/// One host command line, run the way the runner runs a program: in the folder asked, at the work score every
/// command of ours runs at, with nothing of the line interpolated into a shell.
///
/// A program that is there and answers its own not-signed-in code is the same refusal a program that is not there
/// at all is: the push has landed either way and the pull request waits for a signed-in command line. Decided
/// here, so every road through this module answers it alike.
async fn run_cli<R: Runs>(
    runner: &R,
    host: &'static dyn PullRequests,
    ask: &Ask<'_>,
    args: &[String],
) -> Result<(Option<i32>, String, String), OpError> {
    let line: Vec<&str> = args.iter().map(String::as_str).collect();
    let done = runner.run(ask.cwd, host.program(), &line, None, None).await?;
    if done.code.is_some() && done.code == host.sign_in_exit() {
        return Err(OpError::coded(DaemonErrorCode::NoHostCli, words::no_host_cli(host.host())));
    }
    Ok((done.code, String::from_utf8_lossy(&done.stdout).into_owned(), done.stderr))
}

/// The first line a command line said that is not blank, off stderr before stdout.
fn first_said(stdout: &str, stderr: &str) -> String {
    let first = |text: &str| text.lines().map(str::trim).find(|line| !line.is_empty()).map(str::to_owned);
    first(stderr).or_else(|| first(stdout)).unwrap_or_default()
}

/// The last line it said that is not blank, which is where gh puts the reason it refused.
fn last_said(stdout: &str, stderr: &str) -> String {
    [stderr, stdout]
        .into_iter()
        .flat_map(|text| text.lines().rev())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_owned()
}

fn refused_by(host: &'static dyn PullRequests, stdout: &str, stderr: &str) -> OpError {
    OpError::plain(format!("{} said: {}", host.program(), last_said(stdout, stderr)))
}

/// The pull request as its host has it, with every check on its head and, while it is open, how far its base has
/// moved on; nothing where a branch has none, which is what a line that refused a view by branch means on every host
/// here. A number always names one, so a view of it refused is the line failing, and says so rather than none.
/// A checks line that answered no JSON, which is what gh does on a head with no checks, is no checks.
async fn read_with<R: Runs>(
    runner: &R,
    host: &'static dyn PullRequests,
    repo: &str,
    ask: &Ask<'_>,
    pick: &Pick<'_>,
) -> Result<Option<PullRequest>, OpError> {
    let (code, stdout, said) = run_cli(runner, host, ask, &host.view_argv(repo, pick)).await?;
    if code != Some(0) && matches!(pick, Pick::Number(_)) {
        return Err(refused_by(host, &stdout, &said));
    }
    let Some(mut pr) = (if code == Some(0) { host.read(&stdout) } else { None }) else { return Ok(None) };
    let (_, checks, _) = run_cli(runner, host, ask, &host.checks_argv(repo, pr.number)).await?;
    pr.checks = host.read_checks(&checks).unwrap_or_default();
    if pr.state == PullRequestState::Open && !pr.base.is_empty() && !pr.head_oid.is_empty() {
        let (code, behind, _) = run_cli(runner, host, ask, &host.behind_argv(repo, &pr.base, &pr.head_oid)).await?;
        pr.behind_base = if code == Some(0) { behind.trim().parse().ok() } else { None };
    }
    Ok(Some(pr))
}

/// How far a head branch is from a base branch as the host holds them; not pushed where the host lacks one of them,
/// which for a lead's base that the host does hold is the head.
pub(crate) async fn compare<R: Runs>(runner: &R, ask: &Ask<'_>, base: &str, head: &str) -> Result<GitBranchCompareReply, OpError> {
    let (host, repo) = cli_for(runner, ask).await?;
    let (code, stdout, stderr) = run_cli(runner, host, ask, &host.compare_argv(&repo, base, head)).await?;
    if code != Some(0) {
        if host.not_found(&stderr) {
            return Ok(GitBranchCompareReply { pushed: false, ahead_by: None, behind_by: None, status: None });
        }
        return Err(refused_by(host, &stdout, &stderr));
    }
    let (ahead, behind, status) = host.read_compare(&stdout).ok_or_else(|| refused_by(host, &stdout, &stderr))?;
    Ok(GitBranchCompareReply { pushed: true, ahead_by: Some(ahead), behind_by: Some(behind), status: Some(status) })
}

/// The pull request a branch or a number names, read in full.
pub(crate) async fn read<R: Runs>(runner: &R, ask: &Ask<'_>, pick: &Pick<'_>) -> Result<Option<PullRequest>, OpError> {
    let (host, repo) = cli_for(runner, ask).await?;
    read_with(runner, host, &repo, ask, pick).await
}

/// The branch's pull request, opened where the host has none. Read back through the same line that looks one up, so
/// every fact comes off that command's JSON rather than off what it printed when it opened one.
pub(crate) async fn open<R: Runs>(
    runner: &R,
    ask: &Ask<'_>,
    base: &str,
    branch: &str,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<GitPrReply, OpError> {
    let (host, repo) = cli_for(runner, ask).await?;
    let pick = Pick::Branch(branch);
    let (code, _, _) = run_cli(runner, host, ask, &host.view_argv(&repo, &pick)).await?;
    let created = code != Some(0);
    if created {
        let (code, stdout, stderr) = run_cli(runner, host, ask, &host.create_argv(base, branch, title, body)).await?;
        if code != Some(0) {
            let said = stderr.trim();
            return Err(OpError::plain(format!("{} said: {}", host.program(), if said.is_empty() { stdout.trim() } else { said })));
        }
    }
    match read_with(runner, host, &repo, ask, &pick).await? {
        Some(pr) => Ok(GitPrReply { pr, created }),
        None => Err(OpError::plain(format!("{} opened the pull request and then answered with none for {branch}", host.program()))),
    }
}

/// A pull request's page: title, body, commits, reviews, the conversation, the comments on its lines and its files.
pub(crate) async fn page<R: Runs>(runner: &R, ask: &Ask<'_>, number: u64) -> Result<GitPrViewReply, OpError> {
    let (host, repo) = cli_for(runner, ask).await?;
    let (code, page, said) = run_cli(runner, host, ask, &host.page_argv(&repo, number)).await?;
    if code != Some(0) {
        return Err(refused_by(host, &page, &said));
    }
    let (code, lines, said) = run_cli(runner, host, ask, &host.line_comments_argv(&repo, number)).await?;
    if code != Some(0) {
        return Err(refused_by(host, &lines, &said));
    }
    host.read_page(&page, &lines)
        .ok_or_else(|| OpError::plain(format!("{} answered with a pull request page this does not read", host.program())))
}

/// The failed steps of one job, its last CHECK_LOG_LINES lines: the failure is at the end. Each line comes without
/// the job's name gh puts in front of it, since the message that carries them names the job once.
pub(crate) async fn run_log<R: Runs>(runner: &R, ask: &Ask<'_>, run_id: u64, job_id: u64) -> Result<GitRunLogReply, OpError> {
    let (host, repo) = cli_for(runner, ask).await?;
    let (code, stdout, stderr) = run_cli(runner, host, ask, &host.log_argv(&repo, run_id, job_id)).await?;
    if code != Some(0) {
        return Err(refused_by(host, &stdout, &stderr));
    }
    Ok(last_lines(&stdout, numbers::CHECK_LOG_LINES))
}

fn last_lines(log: &str, cap: usize) -> GitRunLogReply {
    let all: Vec<String> = log
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .map(|line| match line.splitn(3, '\t').collect::<Vec<_>>()[..] {
            [_job, step, text] => format!("{step}\t{text}"),
            _ => line.to_owned(),
        })
        .collect();
    let truncated = all.len() > cap;
    GitRunLogReply { lines: all[all.len().saturating_sub(cap)..].to_vec(), truncated }
}

/// Merges a pull request, or arms it to merge once its checks pass, then reads where it stands: a merge asked to wait
/// on checks that already passed merges at once, and only the host can say which it did. A refusal is the host's
/// own last line.
pub(crate) async fn merge<R: Runs>(
    runner: &R,
    ask: &Ask<'_>,
    number: u64,
    method: MergeMethod,
    auto: bool,
    head_oid: &str,
) -> Result<GitPrMergeReply, OpError> {
    let (host, repo) = cli_for(runner, ask).await?;
    let (code, stdout, stderr) = run_cli(runner, host, ask, &host.merge_argv(&repo, number, method, auto, head_oid)).await?;
    if code != Some(0) {
        return Err(OpError::plain(words::merge_refused(&last_said(&stdout, &stderr))));
    }
    let (code, stdout, _) = run_cli(runner, host, ask, &host.merged_argv(&repo, number)).await?;
    let (merged, auto_armed) = if code == Some(0) { host.read_merged(&stdout) } else { None }.unwrap_or((!auto, auto));
    Ok(GitPrMergeReply { merged, auto_armed })
}

/// How the repository lets a pull request land.
pub(crate) async fn repo_settings<R: Runs>(runner: &R, ask: &Ask<'_>) -> Result<GitRepoReadReply, OpError> {
    let (host, repo) = cli_for(runner, ask).await?;
    let (code, settings, said) = run_cli(runner, host, ask, &host.repo_argv(&repo)).await?;
    if code != Some(0) {
        return Err(refused_by(host, &settings, &said));
    }
    let (code, auto, said) = run_cli(runner, host, ask, &host.auto_merge_argv(&repo)).await?;
    if code != Some(0) {
        return Err(refused_by(host, &auto, &said));
    }
    host.read_repo(&settings, &auto)
        .ok_or_else(|| OpError::plain(format!("{} answered with repository settings this does not read", host.program())))
}

/// The repository's open pull requests, then its open issues. A project with no remote has none to list; a host with
/// no signed-in command line here is an empty list with the note saying so; a list the command line refused for any
/// other reason, such as a repository with issues turned off, is left out with the first line it said as the note,
/// which the composer shows in a one-line slot, and the other list still stands.
pub(crate) async fn list<R: Runs>(runner: &R, cwd: &Path) -> Result<GitPrListReply, OpError> {
    let Some((_, remote_url)) = crate::bring_back::remote_if_any(runner, cwd).await? else {
        return Ok(GitPrListReply { items: Vec::new(), note: None, no_cli_for: None });
    };
    let named = host_name(&remote_url).unwrap_or_else(|| remote_url.clone());
    let unlisted = || GitPrListReply { items: Vec::new(), note: None, no_cli_for: Some(named.clone()) };
    let ask = Ask { cwd, remote_url: &remote_url };
    let host = match cli_for(runner, &ask).await {
        Ok((host, _)) => host,
        Err(e) if e.code == Some(DaemonErrorCode::NoHostCli) => return Ok(unlisted()),
        Err(e) => return Err(e),
    };
    let mut reply = GitPrListReply { items: Vec::new(), note: None, no_cli_for: None };
    for kind in [HostItemKind::PullRequest, HostItemKind::Issue] {
        let (code, stdout, stderr) = match run_cli(runner, host, &ask, &host.list_argv(kind)).await {
            Ok(done) => done,
            Err(e) if e.code == Some(DaemonErrorCode::NoHostCli) => return Ok(unlisted()),
            Err(e) => return Err(e),
        };
        match (code, host.read_list(kind, &stdout)) {
            (Some(0), Some(items)) => reply.items.extend(items),
            _ if reply.note.is_none() => reply.note = Some(format!("{} said: {}", host.program(), first_said(&stdout, &stderr))),
            _ => {}
        }
    }
    Ok(reply)
}

/// A body as a list or a page carries it: at most GIT_PR_LIST_BODY_CAP characters, the cut marked with an ellipsis.
pub(crate) fn cut_body(body: &str) -> String {
    let body = body.trim();
    match body.char_indices().nth(numbers::GIT_PR_LIST_BODY_CAP) {
        Some((at, _)) => format!("{}…", &body[..at]),
        None => body.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::github::tests::{CHECKS_JSON, VIEW_JSON};
    use super::*;
    use crate::git::here::Here;
    use crate::git::recorded::Recorded;
    use wsp_frames::{CheckState, Mergeable};

    const FIELDS: &str =
        "number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,additions,deletions,changedFiles,commits";

    #[test]
    fn the_host_name_is_read_off_a_url_and_off_the_scp_form_alike() {
        for url in
            ["git@github.com:o/r.git", "https://github.com/o/r", "https://user@github.com:443/o/r.git", "ssh://git@GitHub.com/o/r.git"]
        {
            assert_eq!(host_name(url).as_deref(), Some("github.com"), "{url}");
        }
        assert_eq!(host_name("git@gitlab.example.com:o/r.git").as_deref(), Some("gitlab.example.com"));
        // A path with no host in it names no host: a remote that is a folder beside the checkout is one.
        assert_eq!(host_name("/srv/mirrors/r.git"), None);
        assert_eq!(host_name("../origin.git"), None);
        assert_eq!(host_name("origin.git"), None);
    }

    #[test]
    fn the_repository_is_read_off_the_three_forms_a_remote_takes_and_nothing_else() {
        for url in [
            "git@github.com:Zingzy/wsp-pr-lab.git",
            "ssh://git@github.com/Zingzy/wsp-pr-lab",
            "https://github.com/Zingzy/wsp-pr-lab",
            "https://github.com/Zingzy/wsp-pr-lab.git",
            "https://user@github.com:443/Zingzy/wsp-pr-lab.git/",
        ] {
            assert_eq!(repo_of(url).as_deref(), Some("Zingzy/wsp-pr-lab"), "{url}");
        }
        for url in [
            "/srv/mirrors/r.git",
            "https://github.com/Zingzy",
            "https://github.com/o/r/tree/main",
            "git@github.com:o/..",
            "https://github.com/o/r;rm -rf",
        ] {
            assert_eq!(repo_of(url), None, "{url}");
        }
    }

    #[test]
    fn the_registry_answers_for_github_by_either_form_and_for_no_other_host() {
        assert!(host_for("git@github.com:o/r.git").is_some());
        assert!(host_for("https://github.com/o/r").is_some());
        assert!(host_for("git@gitlab.com:o/r.git").is_none());
        assert!(host_for("/srv/mirrors/r.git").is_none());
    }

    /// A gh that records every word it was given and answers about the one pull request it holds, so the roads
    /// through this module are read without a login or a network.
    fn fake_gh() -> tempfile::TempDir {
        let dir = tempfile::Builder::new().prefix("wsp-fake-gh-").tempdir().unwrap();
        let at = dir.path().join("gh");
        std::fs::write(
            &at,
            concat!(
                "#!/bin/sh\n",
                "dir=$(dirname \"$0\")\n",
                "for word in \"$@\"; do printf '%s\\n' \"$word\" >> \"$dir/argv\"; done\n",
                "printf -- '--\\n' >> \"$dir/argv\"\n",
                "case \"$1 $2\" in\n",
                "  'pr view') if [ -f \"$dir/pr.json\" ]; then cat \"$dir/pr.json\"; exit 0; fi\n",
                "        echo 'no pull requests found for branch' >&2; exit 1;;\n",
                "  'pr create') printf '%s' '{\"number\":7,\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"OPEN\",\"baseRefName\":\"main\",\"headRefName\":\"work\",\"headRefOid\":\"abc\"}' > \"$dir/pr.json\"\n",
                "        echo https://github.com/o/r/pull/7; exit 0;;\n",
                "  'pr checks') echo 'no checks reported on the work branch' >&2; exit 1;;\n",
                "  'api repos/o/r/compare/main...abc') echo 2; exit 0;;\n",
                "esac\n",
                "exit 2\n",
            ),
        )
        .unwrap();
        std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        dir
    }

    /// The computer as a case runs it: the fake gh first on the PATH, then this computer's own, since the script
    /// itself runs dirname and cat and a PATH of one directory would leave it without them.
    fn with_gh(dir: &tempfile::TempDir) -> Here {
        Here::on(&format!("{}:{}", dir.path().to_string_lossy(), std::env::var("PATH").unwrap_or_default()))
    }

    /// The words that fake gh was given, one call per inner list.
    fn argv_of(dir: &tempfile::TempDir) -> Vec<Vec<String>> {
        let text = std::fs::read_to_string(dir.path().join("argv")).unwrap_or_default();
        text.split("--\n").filter(|call| !call.trim().is_empty()).map(|call| call.lines().map(str::to_owned).collect()).collect()
    }

    #[tokio::test]
    async fn the_pull_request_is_opened_once_and_found_the_next_time() {
        let gh = fake_gh();
        let runner = with_gh(&gh);
        let ask = Ask { cwd: gh.path(), remote_url: "git@github.com:o/r.git" };
        assert_eq!(read(&runner, &ask, &Pick::Branch("work")).await.unwrap(), None);
        let opened = open(&runner, &ask, "main", "work", None, None).await.unwrap();
        assert_eq!((opened.created, opened.pr.number, opened.pr.state), (true, 7, PullRequestState::Open));
        assert_eq!((opened.pr.url.as_str(), opened.pr.behind_base, opened.pr.checks.len()), ("https://github.com/o/r/pull/7", Some(2), 0));
        let again = open(&runner, &ask, "main", "work", None, None).await.unwrap();
        assert_eq!((again.created, again.pr.number), (false, 7));
        assert_eq!(read(&runner, &ask, &Pick::Branch("work")).await.unwrap().unwrap().number, 7);
        let calls = argv_of(&gh);
        assert_eq!(calls.iter().filter(|c| c.get(1).is_some_and(|w| w == "create")).count(), 1, "{calls:?}");
        assert_eq!(calls[0], ["pr", "view", "work", "-R", "o/r", "--json", FIELDS]);
        assert_eq!(calls[2], ["pr", "create", "--base", "main", "--head", "work", "--fill"]);
    }

    /// A pull request known by number is never answered as none: gh refusing that view is gh failing (offline, signed
    /// out mid-read), and a none would wipe the fact the host holds for one lost read.
    #[tokio::test]
    async fn a_view_by_number_that_fails_is_an_error_and_never_no_pull_request() {
        let gh = fake_gh();
        let runner = with_gh(&gh);
        let ask = Ask { cwd: gh.path(), remote_url: "git@github.com:o/r.git" };
        let said = read(&runner, &ask, &Pick::Number(7)).await.unwrap_err().message;
        assert!(said.contains("no pull requests found for branch"), "{said}");
    }

    #[tokio::test]
    async fn a_title_rides_the_line_that_opens_it() {
        let gh = fake_gh();
        let runner = with_gh(&gh);
        let ask = Ask { cwd: gh.path(), remote_url: "https://github.com/o/r" };
        open(&runner, &ask, "main", "work", Some("a title"), Some("a body")).await.unwrap();
        assert_eq!(argv_of(&gh)[1], ["pr", "create", "--base", "main", "--head", "work", "--title", "a title", "--body", "a body"]);
    }

    /// How far a child's branch is from its lead's, as the host holds them: one gh line naming the repository off the
    /// remote and both branches percent-encoded into the path, a head the host lacks read as not pushed, and any
    /// other refusal gh's own last line.
    #[tokio::test]
    async fn a_compare_is_one_gh_line_and_a_head_the_host_lacks_is_not_pushed() {
        let ask = Ask { cwd: Path::new("/Users/p"), remote_url: "git@github.com:Zingzy/wsp.git" };
        let runner = Recorded::new(&["gh"]).answering(vec![(0, "{\"ahead_by\":2,\"behind_by\":1,\"status\":\"diverged\"}\n")]);
        let read = compare(&runner, &ask, "tree/lead", "child/one #2").await.unwrap();
        assert_eq!(
            read,
            GitBranchCompareReply { pushed: true, ahead_by: Some(2), behind_by: Some(1), status: Some("diverged".to_owned()) }
        );
        let calls = runner.asked();
        assert_eq!((calls.len(), calls[0].program.as_str(), calls[0].cwd.as_str()), (1, "gh", "/Users/p"));
        assert_eq!(calls[0].args, ["api", "repos/Zingzy/wsp/compare/tree/lead...child/one%20%232", "--jq", "{ahead_by,behind_by,status}"]);
        let runner = Recorded::new(&["gh"]).answering_said(vec![(1, "{\"message\":\"Not Found\"}", "gh: Not Found (HTTP 404)")]);
        assert_eq!(
            compare(&runner, &ask, "tree/lead", "child/one").await.unwrap(),
            GitBranchCompareReply { pushed: false, ahead_by: None, behind_by: None, status: None }
        );
        let runner = Recorded::new(&["gh"]).answering_said(vec![(1, "", "gh: API rate limit exceeded (HTTP 403)")]);
        assert_eq!(
            compare(&runner, &ask, "tree/lead", "child/one").await.unwrap_err().message,
            "gh said: gh: API rate limit exceeded (HTTP 403)"
        );
    }

    /// The read the host asks on the Mac's own daemon: three gh lines, each naming the repository off the remote it
    /// was handed, in the folder it was handed, and never a git anywhere, so a copy's own configuration is not read.
    #[tokio::test]
    async fn a_read_is_three_gh_lines_naming_the_repository_and_never_git() {
        let runner = Recorded::new(&["gh"]).answering(vec![(0, VIEW_JSON), (8, CHECKS_JSON), (0, "3\n")]);
        let ask = Ask { cwd: Path::new("/Users/p"), remote_url: "git@github.com:Zingzy/wsp.git" };
        let pr = read(&runner, &ask, &Pick::Branch("ticket/batch9-git")).await.unwrap().unwrap();
        let calls = runner.asked();
        assert!(calls.iter().all(|c| c.program == "gh" && c.cwd == "/Users/p"), "a call ran git or ran somewhere else");
        assert_eq!(calls[0].args, ["pr", "view", "ticket/batch9-git", "-R", "Zingzy/wsp", "--json", FIELDS]);
        assert_eq!(calls[1].args, ["pr", "checks", "870", "-R", "Zingzy/wsp", "--json", "name,bucket,link,workflow,description"]);
        assert_eq!(
            calls[2].args,
            ["api", "repos/Zingzy/wsp/compare/main...ec5c10de663bd1860925ad42e9580bab4eb1d377", "--jq", ".behind_by"]
        );
        assert_eq!((pr.number, pr.mergeable, pr.behind_base), (870, Mergeable::Mergeable, Some(3)));
        // gh answers its checks with a pending code while one runs; the JSON is what is read.
        assert_eq!(pr.checks.iter().map(|c| c.state).collect::<Vec<_>>()[..2], [CheckState::Fail, CheckState::Pending]);
        assert_eq!(pr.checks[0].run.map(|r| (r.run_id, r.job_id)), Some((36495564111, 109174214002)));
        // By number the same, and a merged one never asks how far behind it is.
        let merged = VIEW_JSON.replace("\"OPEN\"", "\"MERGED\"");
        let runner = Recorded::new(&["gh"]).answering(vec![(0, &merged), (1, "")]);
        let pr = read(&runner, &ask, &Pick::Number(870)).await.unwrap().unwrap();
        assert_eq!((pr.state, pr.behind_base, pr.checks.len()), (PullRequestState::Merged, None, 0));
        assert_eq!(runner.asked().len(), 2);
        assert_eq!(runner.asked()[0].args[2], "870");
    }

    #[tokio::test]
    async fn a_remote_that_names_no_repository_or_another_host_is_refused_by_name_and_runs_nothing() {
        for (remote, named) in
            [("https://github.com/Zingzy", "github.com"), ("git@gitlab.com:o/r.git", "gitlab.com"), ("/srv/r.git", "/srv/r.git")]
        {
            let runner = Recorded::new(&["gh"]);
            let ask = Ask { cwd: Path::new("/Users/p"), remote_url: remote };
            let err = read(&runner, &ask, &Pick::Number(1)).await.unwrap_err();
            assert_eq!((err.code, err.message), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli(named)), "{remote}");
            assert!(runner.asked().is_empty(), "{remote}");
        }
    }

    /// The pull request half runs the host's command line through the way of running it was handed, in the
    /// checkout that way sees: on a workspace of a computer somebody owns that is a gh inside the workspace, signed
    /// in with what that computer holds, and never a gh of the daemon's own.
    #[tokio::test]
    async fn the_host_command_line_runs_through_the_way_it_was_handed() {
        let runner = Recorded::new(&["gh"]).answering(vec![
            (1, ""),
            (0, "https://github.com/o/r/pull/7\n"),
            (0, r#"{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN"}"#),
        ]);
        let ask = Ask { cwd: Path::new("/private/tmp/proof/repo"), remote_url: "git@github.com:o/r.git" };
        let opened = open(&runner, &ask, "main", "work", Some("a title"), Some("a body")).await.unwrap();
        assert_eq!((opened.created, opened.pr.number), (true, 7));
        let calls = runner.asked();
        assert!(calls.iter().all(|call| call.cwd == "/private/tmp/proof/repo" && call.program == "gh"), "a call ran somewhere else");
        assert_eq!(calls[0].args, ["pr", "view", "work", "-R", "o/r", "--json", FIELDS]);
        assert_eq!(calls[1].args, ["pr", "create", "--base", "main", "--head", "work", "--title", "a title", "--body", "a body"]);
        // And a way of running whose PATH holds no gh is the note beside a landed push, whatever the host is.
        let bare = Recorded::new(&[]);
        let err = open(&bare, &ask, "main", "work", None, None).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("github.com").as_str()));
        assert!(bare.asked().is_empty(), "a computer with no gh ran something");
    }

    /// What gh prints on a box it is on and nobody has signed it in, measured on spoo on 2026-09-18: its own
    /// authentication-required code, and a sentence it is free to reword, which is why the code is what is read.
    const SIGN_IN_SAID: &str = "To get started with GitHub CLI, please run:  gh auth login";

    #[tokio::test]
    async fn a_gh_that_is_there_and_not_signed_in_reads_as_a_gh_that_is_not_there() {
        let ask = Ask { cwd: Path::new("/private/tmp/proof/repo"), remote_url: "git@github.com:o/r.git" };
        // Looking one up and opening one answer alike, and the open never reaches its create.
        let looked = Recorded::new(&["gh"]).answering_said(vec![(4, "", SIGN_IN_SAID)]);
        let found = read(&looked, &ask, &Pick::Branch("work")).await.unwrap_err();
        assert_eq!((found.code, found.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("github.com").as_str()));
        let runner = Recorded::new(&["gh"]).answering_said(vec![(4, "", SIGN_IN_SAID), (4, "", SIGN_IN_SAID)]);
        let opened = open(&runner, &ask, "main", "work", None, None).await.unwrap_err();
        assert_eq!((opened.code, opened.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("github.com").as_str()));
        let calls = runner.asked();
        assert_eq!(calls.len(), 1, "a gh nobody is signed in on was asked to create a pull request");
        assert_eq!(calls[0].args, ["pr", "view", "work", "-R", "o/r", "--json", FIELDS]);
    }

    #[tokio::test]
    async fn a_gh_that_refused_for_any_other_reason_still_says_what_it_said() {
        let ask = Ask { cwd: Path::new("/private/tmp/proof/repo"), remote_url: "git@github.com:o/r.git" };
        let runner = Recorded::new(&["gh"])
            .answering_said(vec![(1, "", "no pull requests found for branch"), (1, "", "could not create pull request")]);
        let refused = open(&runner, &ask, "main", "work", None, None).await.unwrap_err();
        assert_eq!(refused.code, None);
        assert_eq!(refused.message, "gh said: could not create pull request");
        // And a branch with no pull request is still a branch with no pull request rather than a refusal.
        let quiet = Recorded::new(&["gh"]).answering_said(vec![(1, "", "no pull requests found for branch")]);
        assert_eq!(read(&quiet, &ask, &Pick::Branch("work")).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_failed_log_keeps_its_last_lines_without_the_job_in_front_of_each() {
        let log: String = (1..=400).map(|n| format!("ci job\tRun tests\t2026-09-28T10:00:00Z line {n}\r\n")).collect();
        let runner = Recorded::new(&["gh"]).answering(vec![(0, &log)]);
        let ask = Ask { cwd: Path::new("/Users/p"), remote_url: "https://github.com/o/r" };
        let read = run_log(&runner, &ask, 36, 109).await.unwrap();
        assert_eq!((read.lines.len(), read.truncated), (numbers::CHECK_LOG_LINES, true));
        assert_eq!(read.lines[0], "Run tests\t2026-09-28T10:00:00Z line 101");
        assert_eq!(read.lines.last().unwrap(), "Run tests\t2026-09-28T10:00:00Z line 400");
        assert_eq!(runner.asked()[0].args, ["run", "view", "36", "-R", "o/r", "--job", "109", "--log-failed"]);
        let short = last_lines("one\ntwo\n", numbers::CHECK_LOG_LINES);
        assert_eq!((short.lines, short.truncated), (vec!["one".to_owned(), "two".to_owned()], false));
        let refused = Recorded::new(&["gh"]).answering_said(vec![(1, "", "HTTP 404: Not Found")]);
        assert_eq!(run_log(&refused, &ask, 1, 2).await.unwrap_err().message, "gh said: HTTP 404: Not Found");
    }

    #[tokio::test]
    async fn a_merge_names_the_head_and_reads_back_what_it_did_and_a_refusal_is_ghs_last_line() {
        let ask = Ask { cwd: Path::new("/Users/p"), remote_url: "https://github.com/o/r" };
        let runner = Recorded::new(&["gh"]).answering(vec![(0, ""), (0, r#"{"state":"MERGED","autoMergeRequest":null}"#)]);
        let done = merge(&runner, &ask, 12, MergeMethod::Squash, false, "abc123").await.unwrap();
        assert_eq!((done.merged, done.auto_armed), (true, false));
        assert_eq!(runner.asked()[0].args, ["pr", "merge", "12", "-R", "o/r", "--squash", "--match-head-commit", "abc123"]);
        let armed = Recorded::new(&["gh"]).answering(vec![(0, ""), (0, r#"{"state":"OPEN","autoMergeRequest":{"mergeMethod":"MERGE"}}"#)]);
        let done = merge(&armed, &ask, 12, MergeMethod::Merge, true, "abc123").await.unwrap();
        assert_eq!((done.merged, done.auto_armed), (false, true));
        let said = "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)";
        let refused = Recorded::new(&["gh"]).answering_said(vec![(1, "", &format!("X Pull request o/r#12 was not merged\n{said}\n"))]);
        let err = merge(&refused, &ask, 12, MergeMethod::Merge, false, "abc123").await.unwrap_err();
        assert_eq!(err.message, words::merge_refused(said));
        assert_eq!(refused.asked().len(), 1);
    }

    #[tokio::test]
    async fn a_page_reads_two_lines_and_the_repository_two_more() {
        let ask = Ask { cwd: Path::new("/Users/p"), remote_url: "https://github.com/o/r" };
        let runner = Recorded::new(&["gh"])
            .answering(vec![(0, r#"{"title":"t","body":"b","commits":[],"reviews":[],"comments":[],"files":[]}"#), (0, "[]")]);
        let read = page(&runner, &ask, 12).await.unwrap();
        assert_eq!((read.title.as_str(), read.review_comments.len()), ("t", 0));
        assert_eq!(runner.asked()[1].args, ["api", "repos/o/r/pulls/12/comments?per_page=100"]);
        let runner = Recorded::new(&["gh"]).answering(vec![
            (0, r#"{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"viewerDefaultMergeMethod":"SQUASH"}"#),
            (0, "true\n"),
        ]);
        let read = repo_settings(&runner, &ask).await.unwrap();
        assert_eq!(
            (read.methods, read.default_method, read.auto_merge),
            (vec![MergeMethod::Merge, MergeMethod::Squash], MergeMethod::Squash, true)
        );
    }

    const PR_JSON: &str =
        "[{\"number\":42,\"title\":\"Login breaks on Safari\",\"body\":\"cookie\",\"url\":\"https://github.com/o/r/pull/42\"}]";
    const ISSUE_JSON: &str = "[{\"number\":7,\"title\":\"Add dark mode\",\"body\":\"\",\"url\":\"https://github.com/o/r/issues/7\"}]";

    #[tokio::test]
    async fn the_open_pull_requests_then_issues_are_listed_by_argv_in_the_checkout() {
        let runner =
            Recorded::new(&["gh"]).answering(vec![(0, "origin\n"), (0, "git@github.com:o/r.git\n"), (0, PR_JSON), (0, ISSUE_JSON)]);
        let listed = list(&runner, Path::new("/private/tmp/proof/repo")).await.unwrap();
        assert_eq!(listed.note, None);
        let numbers: Vec<(u64, HostItemKind)> = listed.items.iter().map(|i| (i.number, i.kind)).collect();
        assert_eq!(numbers, [(42, HostItemKind::PullRequest), (7, HostItemKind::Issue)]);
        let calls = runner.asked();
        assert!(calls.iter().all(|c| c.cwd == "/private/tmp/proof/repo" && c.stdin.is_none()), "a call ran somewhere else");
        assert_eq!(calls[2].program, "gh");
        assert_eq!(calls[2].args, ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,url"]);
        assert_eq!(calls[3].args, ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,url"]);
    }

    #[tokio::test]
    async fn a_gh_nobody_signed_in_lists_nothing_with_one_line_saying_why() {
        let runner =
            Recorded::new(&["gh"]).answering_said(vec![(0, "origin\n", ""), (0, "https://github.com/o/r\n", ""), (4, "", SIGN_IN_SAID)]);
        let listed = list(&runner, Path::new("/private/tmp/proof/repo")).await.unwrap();
        assert!(listed.items.is_empty());
        assert_eq!((listed.no_cli_for.as_deref(), listed.note), (Some("github.com"), None));
        // No gh on the PATH reads the same, and nothing is run for it.
        let bare = Recorded::new(&[]).answering(vec![(0, "origin\n"), (0, "git@github.com:o/r.git\n")]);
        let listed = list(&bare, Path::new("/private/tmp/proof/repo")).await.unwrap();
        assert_eq!((listed.no_cli_for.as_deref(), listed.note), (Some("github.com"), None));
        assert!(bare.asked().iter().all(|c| c.program == "git"));
    }

    #[tokio::test]
    async fn a_list_gh_refused_is_left_out_with_what_it_said_and_the_other_stands() {
        let said = "the 'o/r' repository has disabled issues";
        let runner = Recorded::new(&["gh"]).answering_said(vec![
            (0, "origin\n", ""),
            (0, "git@github.com:o/r.git\n", ""),
            (0, PR_JSON, ""),
            (1, "", said),
        ]);
        let listed = list(&runner, Path::new("/private/tmp/proof/repo")).await.unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(listed.note, Some(format!("gh said: {said}")));
    }

    #[tokio::test]
    async fn a_list_gh_refused_in_two_lines_is_noted_by_its_first() {
        let runner = Recorded::new(&["gh"]).answering_said(vec![
            (0, "origin\n", ""),
            (0, "git@github.com:o/r.git\n", ""),
            (1, "", "\nerror connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n"),
            (1, "", "error connecting to api.github.com\n"),
        ]);
        let listed = list(&runner, Path::new("/private/tmp/proof/repo")).await.unwrap();
        assert_eq!(listed.note.as_deref(), Some("gh said: error connecting to api.github.com"));
    }

    #[tokio::test]
    async fn a_project_with_no_remote_has_nothing_to_list_and_asks_no_host() {
        let runner = Recorded::new(&["gh"]).answering(vec![(0, "")]);
        let listed = list(&runner, Path::new("/private/tmp/proof/repo")).await.unwrap();
        assert_eq!((listed.items.len(), listed.note), (0, None));
        assert_eq!(runner.asked().len(), 1);
    }

    #[tokio::test]
    async fn a_computer_with_no_command_line_for_the_host_says_the_pull_request_waits() {
        let gh = fake_gh();
        let runner = with_gh(&gh);
        // A computer whose PATH holds no gh at all: the module is known and the program is not there.
        let bare = Here::on("");
        let nowhere = Ask { cwd: gh.path(), remote_url: "git@github.com:o/r.git" };
        for err in [
            read(&bare, &nowhere, &Pick::Branch("work")).await.unwrap_err(),
            open(&bare, &nowhere, "main", "work", None, None).await.unwrap_err(),
        ] {
            assert_eq!(err.code, Some(DaemonErrorCode::NoHostCli));
            assert_eq!(err.message, words::no_host_cli("github.com"));
        }
        // A host no module here answers for reads the same: the push landed and the pull request waits for a line.
        let elsewhere = Ask { cwd: gh.path(), remote_url: "git@gitlab.com:o/r.git" };
        let err = open(&runner, &elsewhere, "main", "work", None, None).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("gitlab.com").as_str()));
        assert!(argv_of(&gh).is_empty());
    }
}
