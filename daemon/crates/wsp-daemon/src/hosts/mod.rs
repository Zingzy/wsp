// SPDX-License-Identifier: AGPL-3.0-only
//! Pull requests through the git host's own signed-in command line, which is what the image or the box carries:
//! wsp holds no token for a git host and speaks no host's API. One module per host, each saying which program it
//! runs, the argv for asking and for opening, and how to read that program's JSON; one registry keyed on the name
//! the remote's url carries. Adding GitLab is a module beside github.rs and one row in HOSTS.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use wsp_frames::{numbers, words, DaemonErrorCode, GitPrReply, PullRequest};

use crate::paths::OpError;

mod github;

/// One git host's command line, as data: what to run, what to run it with, and how to read what it answered.
pub(crate) trait PullRequests: Sync {
    /// The host name a remote's url carries for this module.
    fn host(&self) -> &'static str;
    /// The program every one of its lines runs, which is what a computer with no login for this host lacks.
    fn program(&self) -> &'static str;
    /// The line that answers with the branch's pull request as JSON, and refuses where there is none.
    fn find_argv(&self, branch: &str) -> Vec<String>;
    /// The line that opens one. A title turns into the pull request's own title and body; without one the host
    /// fills both from the commits, which is what an agent's branch usually wants said.
    fn create_argv(&self, base: &str, branch: &str, title: Option<&str>, body: Option<&str>) -> Vec<String>;
    /// The pull request one of those lines answered with, off its JSON and never its prose; nothing where the JSON
    /// is not one this module reads.
    fn read(&self, stdout: &str) -> Option<PullRequest>;
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

/// What one pull request call is made against: the checkout, the remote that says which host it is, the branch,
/// and the PATH the host's command line is looked up on, which is the daemon's own unless a caller names another.
pub(crate) struct Ask<'a> {
    pub(crate) cwd: &'a Path,
    pub(crate) remote_url: &'a str,
    pub(crate) branch: &'a str,
    pub(crate) path: &'a str,
}

/// The PATH this daemon runs with, which inside a workspace is the image's own.
pub(crate) fn daemon_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// The module and the program for this ask, refused in one sentence where either is missing: an unknown host and a
/// host whose command line is not installed read the same to a person, and the push has already landed either way.
fn cli_for(ask: &Ask<'_>) -> Result<(&'static dyn PullRequests, PathBuf), OpError> {
    let named = host_name(ask.remote_url).unwrap_or_else(|| ask.remote_url.to_owned());
    let refused = || OpError::coded(DaemonErrorCode::NoHostCli, words::no_host_cli(&named));
    let host = host_for(ask.remote_url).ok_or_else(refused)?;
    let program = on_path(ask.path, host.program()).ok_or_else(refused)?;
    Ok((host, program))
}

/// The program on that PATH, by the same reading a shell makes: the first entry holding a file that can be run.
fn on_path(path: &str, program: &str) -> Option<PathBuf> {
    path.split(':').filter(|dir| !dir.is_empty()).map(|dir| Path::new(dir).join(program)).find(|at| at.is_file())
}

struct CliResult {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// One host command line, run in the checkout at the work score every command of ours runs at, with nothing of the
/// line interpolated into a shell.
async fn run_cli(program: &Path, cwd: &Path, args: &[String]) -> Result<CliResult, OpError> {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(format!("{}; exec \"$0\" \"$@\"", numbers::work_score_line()))
        .arg(program)
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let mut out = String::new();
    let mut err = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut out).await;
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut err).await;
    }
    let status = child.wait().await?;
    Ok(CliResult { code: status.code(), stdout: out, stderr: err })
}

/// The branch's pull request as its host has it, or nothing where the host knows none: a line that refused is a
/// branch with no pull request, which is what every one of these hosts answers with.
pub(crate) async fn find(ask: &Ask<'_>) -> Result<Option<PullRequest>, OpError> {
    let (host, program) = cli_for(ask)?;
    let asked = run_cli(&program, ask.cwd, &host.find_argv(ask.branch)).await?;
    Ok(if asked.code == Some(0) { host.read(&asked.stdout) } else { None })
}

/// The branch's pull request, opened where the host has none. Read back through the same line that looks one up, so
/// the number and the state come off that command's JSON rather than off what it printed when it opened one.
pub(crate) async fn open(ask: &Ask<'_>, base: &str, title: Option<&str>, body: Option<&str>) -> Result<GitPrReply, OpError> {
    if let Some(pr) = find(ask).await? {
        return Ok(GitPrReply { pr, created: false });
    }
    let (host, program) = cli_for(ask)?;
    let made = run_cli(&program, ask.cwd, &host.create_argv(base, ask.branch, title, body)).await?;
    if made.code != Some(0) {
        let said = made.stderr.trim();
        return Err(OpError::plain(format!("{} said: {}", host.program(), if said.is_empty() { made.stdout.trim() } else { said })));
    }
    match find(ask).await? {
        Some(pr) => Ok(GitPrReply { pr, created: true }),
        None => Err(OpError::plain(format!("{} opened the pull request and then answered with none for {}", host.program(), ask.branch))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn the_registry_answers_for_github_by_either_form_and_for_no_other_host() {
        assert!(host_for("git@github.com:o/r.git").is_some());
        assert!(host_for("https://github.com/o/r").is_some());
        assert!(host_for("git@gitlab.com:o/r.git").is_none());
        assert!(host_for("/srv/mirrors/r.git").is_none());
    }

    /// A gh that records every word it was given and answers about the one pull request it holds, so the two roads
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
                "case \"$2\" in\n",
                "  view) if [ -f \"$dir/pr.json\" ]; then cat \"$dir/pr.json\"; exit 0; fi\n",
                "        echo 'no pull requests found for branch' >&2; exit 1;;\n",
                "  create) printf '%s' '{\"number\":7,\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"OPEN\"}' > \"$dir/pr.json\"\n",
                "        echo https://github.com/o/r/pull/7; exit 0;;\n",
                "esac\n",
                "exit 2\n",
            ),
        )
        .unwrap();
        std::fs::set_permissions(&at, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        dir
    }

    /// The words that fake gh was given, one call per inner list.
    fn argv_of(dir: &tempfile::TempDir) -> Vec<Vec<String>> {
        let text = std::fs::read_to_string(dir.path().join("argv")).unwrap_or_default();
        text.split("--\n").filter(|call| !call.trim().is_empty()).map(|call| call.lines().map(str::to_owned).collect()).collect()
    }

    #[tokio::test]
    async fn the_pull_request_is_opened_once_and_found_the_next_time() {
        let gh = fake_gh();
        let path = gh.path().to_string_lossy().into_owned();
        let ask = Ask { cwd: gh.path(), remote_url: "git@github.com:o/r.git", branch: "work", path: &path };
        assert_eq!(find(&ask).await.unwrap(), None);
        let opened = open(&ask, "main", None, None).await.unwrap();
        assert_eq!((opened.created, opened.pr.number, opened.pr.state), (true, 7, wsp_frames::PullRequestState::Open));
        assert_eq!(opened.pr.url, "https://github.com/o/r/pull/7");
        let again = open(&ask, "main", None, None).await.unwrap();
        assert_eq!((again.created, again.pr.number), (false, 7));
        assert_eq!(find(&ask).await.unwrap().unwrap().number, 7);
        let calls = argv_of(&gh);
        assert_eq!(calls.iter().filter(|c| c.get(1).is_some_and(|w| w == "create")).count(), 1, "{calls:?}");
        assert_eq!(calls[2], ["pr", "create", "--base", "main", "--head", "work", "--fill"]);
        assert_eq!(calls[0], ["pr", "view", "work", "--json", "number,url,state"]);
        // The open looks first and reads the pull request back off the same line afterwards, so the number and the
        // state come off gh's JSON and never off what it printed when it opened one.
        assert_eq!(calls.iter().filter(|c| c.get(1).is_some_and(|w| w == "view")).count(), 5, "{calls:?}");
    }

    #[tokio::test]
    async fn a_title_rides_the_line_that_opens_it() {
        let gh = fake_gh();
        let path = gh.path().to_string_lossy().into_owned();
        let ask = Ask { cwd: gh.path(), remote_url: "https://github.com/o/r", branch: "work", path: &path };
        open(&ask, "main", Some("a title"), Some("a body")).await.unwrap();
        assert_eq!(argv_of(&gh)[1], ["pr", "create", "--base", "main", "--head", "work", "--title", "a title", "--body", "a body"]);
    }

    #[tokio::test]
    async fn a_computer_with_no_command_line_for_the_host_says_the_pull_request_waits() {
        let gh = fake_gh();
        let path = gh.path().to_string_lossy().into_owned();
        let nowhere = Ask { cwd: gh.path(), remote_url: "git@github.com:o/r.git", branch: "work", path: "" };
        for err in [find(&nowhere).await.unwrap_err(), open(&nowhere, "main", None, None).await.unwrap_err()] {
            assert_eq!(err.code, Some(DaemonErrorCode::NoHostCli));
            assert_eq!(err.message, words::no_host_cli("github.com"));
        }
        // A host no module here answers for reads the same: the push landed and the pull request waits for a line.
        let elsewhere = Ask { cwd: gh.path(), remote_url: "git@gitlab.com:o/r.git", branch: "work", path: &path };
        let err = open(&elsewhere, "main", None, None).await.unwrap_err();
        assert_eq!((err.code, err.message.as_str()), (Some(DaemonErrorCode::NoHostCli), words::no_host_cli("gitlab.com").as_str()));
        assert!(argv_of(&gh).is_empty());
    }

    #[test]
    fn a_program_is_found_on_the_path_the_caller_named_and_nowhere_else() {
        let dir = tempfile::Builder::new().prefix("wsp-host-cli-").tempdir().unwrap();
        let bin = dir.path().join("gh");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        assert_eq!(on_path(&dir.path().to_string_lossy(), "gh"), Some(bin));
        assert_eq!(on_path("", "gh"), None);
        assert_eq!(on_path(&dir.path().to_string_lossy(), "glab"), None);
    }
}
