// SPDX-License-Identifier: AGPL-3.0-only
//! GitHub through gh, the command line the image signs in once: `gh pr view --json` for what is there and
//! `gh pr create` for what is not, `gh pr checks` and `gh api` for the checks and the counts, `gh run view` for a
//! failed job's log and `gh pr merge` for a merge, each told the repository with `-R` rather than reading it off a
//! checkout.

use serde::de::IgnoredAny;
use serde::Deserialize;
use wsp_frames::{
    numbers, CheckState, GitPrViewReply, GitRepoReadReply, HostItem, HostItemKind, IssueComment, IssueRead, MergeMethod, Mergeable,
    PullRequest, PullRequestCheck, PullRequestCheckRun, PullRequestComment, PullRequestCommit, PullRequestFile, PullRequestFork,
    PullRequestReview, PullRequestReviewComment, PullRequestState, ReviewComment, ReviewEvent, ReviewSide, ReviewState,
};

use super::{Pick, PullRequests};

pub(crate) struct GitHub;

/// The fields a read asks gh for, in gh's own spelling.
const FIELDS: &str = "number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,additions,deletions,changedFiles,commits,author,isCrossRepository,maintainerCanModify,headRepositoryOwner";

/// gh's JSON for one pull request; every word in it is the API's, in capitals.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    number: u64,
    url: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    head_ref_oid: String,
    #[serde(default)]
    mergeable: String,
    #[serde(default)]
    merge_state_status: String,
    #[serde(default)]
    review_decision: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    changed_files: u64,
    #[serde(default)]
    commits: Vec<GhHeadCommit>,
    author: Option<GhLogin>,
    #[serde(default)]
    is_cross_repository: bool,
    #[serde(default)]
    maintainer_can_modify: bool,
    head_repository_owner: Option<GhLogin>,
}

/// One commit of the list a read asks for, of which only the head's subject is kept.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhHeadCommit {
    #[serde(default)]
    oid: String,
    #[serde(default)]
    message_headline: String,
}

/// The fields a check is asked for.
const CHECK_FIELDS: &str = "name,bucket,link,workflow,description";

/// gh's JSON for one check, with the one word gh folds every service's states into.
#[derive(Deserialize)]
struct GhCheck {
    name: String,
    #[serde(default)]
    bucket: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    workflow: String,
    #[serde(default)]
    description: String,
}

/// The fields a pull request's page asks for.
const PAGE_FIELDS: &str = "title,body,author,updatedAt,commits,reviews,comments,files";

#[derive(Deserialize)]
struct GhLogin {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct GhCommitAuthor {
    #[serde(default)]
    login: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCommit {
    oid: String,
    #[serde(default)]
    message_headline: String,
    #[serde(default)]
    committed_date: String,
    #[serde(default)]
    authors: Vec<GhCommitAuthor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReview {
    author: Option<GhLogin>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    submitted_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhComment {
    author: Option<GhLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Deserialize)]
struct GhFile {
    path: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPage {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    author: Option<GhLogin>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    commits: Vec<GhCommit>,
    #[serde(default)]
    reviews: Vec<GhReview>,
    #[serde(default)]
    comments: Vec<GhComment>,
    #[serde(default)]
    files: Vec<GhFile>,
}

/// The REST API's JSON for one comment on a line; it is not in gh's pull request JSON at all.
#[derive(Deserialize)]
struct GhLineComment {
    id: u64,
    path: String,
    line: Option<u64>,
    original_line: Option<u64>,
    side: Option<String>,
    user: Option<GhLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    created_at: String,
}

/// gh's JSON for a repository's merge settings.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepo {
    #[serde(default)]
    merge_commit_allowed: bool,
    #[serde(default)]
    squash_merge_allowed: bool,
    #[serde(default)]
    rebase_merge_allowed: bool,
    #[serde(default)]
    viewer_default_merge_method: String,
}

/// gh's JSON for where a pull request stands after a merge was asked for.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhMerged {
    state: String,
    auto_merge_request: Option<IgnoredAny>,
}

/// The fields an issue read asks for.
const ISSUE_FIELDS: &str = "number,url,title,body,state,comments";

/// gh's JSON for an issue, or a pull request read as the issue it also is.
#[derive(Deserialize)]
struct GhIssue {
    number: u64,
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    comments: Vec<GhComment>,
}

/// The REST API's JSON for one file of a pull request, whose patch carries the hunks a comment on a line must fall in.
#[derive(Deserialize)]
struct GhPrFile {
    filename: String,
    #[serde(default)]
    patch: String,
}

/// The REST API's JSON for a review once posted.
#[derive(Deserialize)]
struct GhPostedReview {
    #[serde(default)]
    html_url: String,
}

/// The fields a list asks for, in gh's own spelling.
const LIST_FIELDS: &str = "number,title,body,url";

/// gh's JSON for one open pull request or issue in a list.
#[derive(Deserialize)]
struct GhItem {
    number: u64,
    title: String,
    #[serde(default)]
    body: String,
    url: String,
}

fn state_of(word: &str) -> Option<PullRequestState> {
    match word.to_ascii_uppercase().as_str() {
        "OPEN" => Some(PullRequestState::Open),
        "MERGED" => Some(PullRequestState::Merged),
        "CLOSED" => Some(PullRequestState::Closed),
        _ => None,
    }
}

fn mergeable_of(word: &str) -> Mergeable {
    match word.to_ascii_uppercase().as_str() {
        "MERGEABLE" => Mergeable::Mergeable,
        "CONFLICTING" => Mergeable::Conflicting,
        _ => Mergeable::Unknown,
    }
}

fn review_of(word: &str) -> ReviewState {
    match word.to_ascii_uppercase().as_str() {
        "APPROVED" => ReviewState::Approved,
        "CHANGES_REQUESTED" => ReviewState::ChangesAsked,
        "REVIEW_REQUIRED" => ReviewState::Required,
        _ => ReviewState::None,
    }
}

/// gh's bucket for a check; a word a later gh adds reads as still running rather than as passed.
fn check_state_of(bucket: &str) -> CheckState {
    match bucket {
        "pass" => CheckState::Pass,
        "fail" => CheckState::Fail,
        "skipping" => CheckState::Skipped,
        "cancel" => CheckState::Cancelled,
        _ => CheckState::Pending,
    }
}

fn method_of(word: &str) -> Option<MergeMethod> {
    match word.to_ascii_uppercase().as_str() {
        "MERGE" => Some(MergeMethod::Merge),
        "SQUASH" => Some(MergeMethod::Squash),
        "REBASE" => Some(MergeMethod::Rebase),
        _ => None,
    }
}

fn method_flag(method: MergeMethod) -> &'static str {
    match method {
        MergeMethod::Merge => "--merge",
        MergeMethod::Squash => "--squash",
        MergeMethod::Rebase => "--rebase",
    }
}

/// The run and the job an Actions check's link names, `.../actions/runs/<run>/job/<job>`; nothing for any other link.
fn run_of(link: &str) -> Option<PullRequestCheckRun> {
    let (_, rest) = link.split_once("/actions/runs/")?;
    let (run, rest) = rest.split_once("/job/")?;
    let job: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some(PullRequestCheckRun { run_id: run.parse().ok()?, job_id: job.parse().ok()? })
}

/// A branch name as one part of an API path: every byte but a letter, a digit, `-._~` and the `/` GitHub reads inside
/// a branch name escaped, since this is the one place a pull request's branch reaches a URL.
fn path_part(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn some(text: String) -> Option<String> {
    (!text.trim().is_empty()).then_some(text)
}

fn login(author: Option<GhLogin>) -> String {
    author.map(|a| a.login).unwrap_or_default()
}

fn commit_author(authors: Vec<GhCommitAuthor>) -> String {
    authors.into_iter().next().map(|a| if a.login.is_empty() { a.name } else { a.login }).unwrap_or_default()
}

fn words(line: &[&str]) -> Vec<String> {
    line.iter().map(|w| (*w).to_owned()).collect()
}

impl PullRequests for GitHub {
    fn host(&self) -> &'static str {
        "github.com"
    }

    fn program(&self) -> &'static str {
        "gh"
    }

    fn view_argv(&self, repo: &str, pick: &Pick<'_>) -> Vec<String> {
        words(&["pr", "view", &pick.word(), "-R", repo, "--json", FIELDS])
    }

    fn create_argv(&self, base: &str, branch: &str, title: Option<&str>, body: Option<&str>) -> Vec<String> {
        // The fill always stands, and a title or a body given wins over what it fills, as gh's own help says.
        let mut argv = words(&["pr", "create", "--base", base, "--head", branch, "--fill"]);
        if let Some(title) = title {
            argv.extend(["--title".to_owned(), title.to_owned()]);
        }
        if let Some(body) = body {
            argv.extend(["--body".to_owned(), body.to_owned()]);
        }
        argv
    }

    fn read(&self, stdout: &str) -> Option<PullRequest> {
        let read: GhPullRequest = serde_json::from_str(stdout.trim()).ok()?;
        let head = read.commits.iter().find(|c| c.oid == read.head_ref_oid).or(read.commits.last());
        let head_subject = head.map(|c| c.message_headline.clone()).unwrap_or_default();
        Some(PullRequest {
            number: read.number,
            url: read.url,
            state: state_of(&read.state)?,
            host: self.host().to_owned(),
            draft: read.is_draft,
            base: read.base_ref_name,
            branch: read.head_ref_name,
            head_oid: read.head_ref_oid,
            head_subject,
            mergeable: mergeable_of(&read.mergeable),
            merge_state: read.merge_state_status.to_ascii_lowercase(),
            review: review_of(&read.review_decision),
            checks: Vec::new(),
            additions: read.additions,
            deletions: read.deletions,
            changed_files: read.changed_files,
            commits: read.commits.len() as u64,
            behind_base: None,
            author: read.author.map(|a| a.login).filter(|l| !l.is_empty()),
            fork: read.is_cross_repository.then(|| PullRequestFork {
                owner: read.head_repository_owner.map(|o| o.login).unwrap_or_default(),
                pushable: read.maintainer_can_modify,
            }),
        })
    }

    fn checks_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["pr", "checks", &number.to_string(), "-R", repo, "--json", CHECK_FIELDS])
    }

    fn read_checks(&self, stdout: &str) -> Option<Vec<PullRequestCheck>> {
        let read: Vec<GhCheck> = serde_json::from_str(stdout.trim()).ok()?;
        Some(
            read.into_iter()
                .map(|c| PullRequestCheck {
                    run: run_of(&c.link),
                    state: check_state_of(&c.bucket),
                    name: c.name,
                    workflow: some(c.workflow),
                    link: some(c.link),
                    description: some(c.description),
                })
                .collect(),
        )
    }

    fn behind_argv(&self, repo: &str, base: &str, head_oid: &str) -> Vec<String> {
        words(&["api", &format!("repos/{repo}/compare/{}...{}", path_part(base), path_part(head_oid)), "--jq", ".behind_by"])
    }

    fn compare_argv(&self, repo: &str, base: &str, head: &str) -> Vec<String> {
        words(&["api", &format!("repos/{repo}/compare/{}...{}", path_part(base), path_part(head)), "--jq", "{ahead_by,behind_by,status}"])
    }

    fn read_compare(&self, stdout: &str) -> Option<(u64, u64, String)> {
        #[derive(serde::Deserialize)]
        struct Compared {
            ahead_by: u64,
            behind_by: u64,
            status: String,
        }
        let read: Compared = serde_json::from_str(stdout.trim()).ok()?;
        Some((read.ahead_by, read.behind_by, read.status))
    }

    fn not_found(&self, stderr: &str) -> bool {
        stderr.contains("(HTTP 404)")
    }

    fn page_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["pr", "view", &number.to_string(), "-R", repo, "--json", PAGE_FIELDS])
    }

    fn line_comments_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["api", &format!("repos/{repo}/pulls/{number}/comments?per_page=100")])
    }

    fn read_page(&self, page: &str, line_comments: &str) -> Option<GitPrViewReply> {
        let read: GhPage = serde_json::from_str(page.trim()).ok()?;
        let lines: Vec<GhLineComment> = serde_json::from_str(line_comments.trim()).ok()?;
        let cut = super::cut_body;
        Some(GitPrViewReply {
            title: read.title,
            body: cut(&read.body),
            author: login(read.author),
            updated_at: read.updated_at,
            commits: read
                .commits
                .into_iter()
                .map(|c| PullRequestCommit {
                    oid: c.oid,
                    subject: c.message_headline,
                    at: c.committed_date,
                    author: commit_author(c.authors),
                })
                .collect(),
            reviews: read
                .reviews
                .into_iter()
                .map(|r| PullRequestReview {
                    author: login(r.author),
                    state: r.state.to_ascii_lowercase(),
                    body: cut(&r.body),
                    at: r.submitted_at.unwrap_or_default(),
                })
                .collect(),
            comments: read
                .comments
                .into_iter()
                .map(|c| PullRequestComment { author: login(c.author), body: cut(&c.body), at: c.created_at })
                .collect(),
            review_comments: lines
                .into_iter()
                .map(|c| PullRequestReviewComment {
                    id: c.id,
                    path: c.path,
                    line: c.line.or(c.original_line),
                    side: c.side,
                    author: login(c.user),
                    body: cut(&c.body),
                    url: c.html_url,
                    at: c.created_at,
                })
                .collect(),
            files: read
                .files
                .into_iter()
                .map(|f| PullRequestFile { path: f.path, additions: f.additions, deletions: f.deletions })
                .collect(),
        })
    }

    fn log_argv(&self, repo: &str, run_id: u64, job_id: u64) -> Vec<String> {
        words(&["run", "view", &run_id.to_string(), "-R", repo, "--job", &job_id.to_string(), "--log-failed"])
    }

    fn merge_argv(&self, repo: &str, number: u64, method: MergeMethod, auto: bool, head_oid: &str) -> Vec<String> {
        let mut argv = words(&["pr", "merge", &number.to_string(), "-R", repo, method_flag(method)]);
        if auto {
            argv.push("--auto".to_owned());
        }
        argv.extend(["--match-head-commit".to_owned(), head_oid.to_owned()]);
        argv
    }

    fn merged_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["pr", "view", &number.to_string(), "-R", repo, "--json", "state,autoMergeRequest"])
    }

    fn read_merged(&self, stdout: &str) -> Option<(bool, bool)> {
        let read: GhMerged = serde_json::from_str(stdout.trim()).ok()?;
        let merged = state_of(&read.state) == Some(PullRequestState::Merged);
        Some((merged, !merged && read.auto_merge_request.is_some()))
    }

    fn repo_argv(&self, repo: &str) -> Vec<String> {
        words(&["repo", "view", repo, "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod"])
    }

    fn auto_merge_argv(&self, repo: &str) -> Vec<String> {
        words(&["api", &format!("repos/{repo}"), "--jq", ".allow_auto_merge"])
    }

    fn read_repo(&self, repo: &str, auto_merge: &str) -> Option<GitRepoReadReply> {
        let read: GhRepo = serde_json::from_str(repo.trim()).ok()?;
        let methods: Vec<MergeMethod> = [
            (read.merge_commit_allowed, MergeMethod::Merge),
            (read.squash_merge_allowed, MergeMethod::Squash),
            (read.rebase_merge_allowed, MergeMethod::Rebase),
        ]
        .into_iter()
        .filter_map(|(allowed, method)| allowed.then_some(method))
        .collect();
        let named = method_of(&read.viewer_default_merge_method).filter(|m| methods.contains(m));
        let default_method = named.or_else(|| methods.first().copied())?;
        Some(GitRepoReadReply { methods, default_method, auto_merge: auto_merge.trim() == "true" })
    }

    fn list_argv(&self, kind: HostItemKind) -> Vec<String> {
        let noun = match kind {
            HostItemKind::PullRequest => "pr",
            HostItemKind::Issue => "issue",
        };
        let limit = numbers::GIT_PR_LIST_CAP.to_string();
        words(&[noun, "list", "--state", "open", "--limit", &limit, "--json", LIST_FIELDS])
    }

    fn read_list(&self, kind: HostItemKind, stdout: &str) -> Option<Vec<HostItem>> {
        let read: Vec<GhItem> = serde_json::from_str(stdout.trim()).ok()?;
        Some(
            read.into_iter()
                .map(|item| HostItem { kind, number: item.number, title: item.title, body: super::cut_body(&item.body), url: item.url })
                .collect(),
        )
    }

    fn issue_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["issue", "view", &number.to_string(), "-R", repo, "--json", ISSUE_FIELDS])
    }

    fn read_issue(&self, stdout: &str) -> Option<IssueRead> {
        let read: GhIssue = serde_json::from_str(stdout.trim()).ok()?;
        let cut = super::cut_body;
        Some(IssueRead {
            number: read.number,
            url: read.url,
            title: read.title,
            body: cut(&read.body),
            state: read.state,
            comments: read
                .comments
                .into_iter()
                .map(|c| IssueComment { author: login(c.author), body: cut(&c.body), at: c.created_at })
                .collect(),
        })
    }

    fn checkout_argv(&self, number: u64) -> Vec<String> {
        words(&["pr", "checkout", &number.to_string()])
    }

    fn diff_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["pr", "diff", &number.to_string(), "-R", repo])
    }

    fn files_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["api", &format!("repos/{repo}/pulls/{number}/files?per_page=100")])
    }

    fn read_files(&self, stdout: &str) -> Option<Vec<(String, String)>> {
        let read: Vec<GhPrFile> = serde_json::from_str(stdout.trim()).ok()?;
        Some(read.into_iter().map(|f| (f.filename, f.patch)).collect())
    }

    fn review_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["api", "--method", "POST", &format!("repos/{repo}/pulls/{number}/reviews"), "--input", "-"])
    }

    fn review_input(&self, head_oid: &str, event: ReviewEvent, body: &str, comments: &[ReviewComment]) -> String {
        let event = match event {
            ReviewEvent::Comment => "COMMENT",
            ReviewEvent::Approve => "APPROVE",
            ReviewEvent::RequestChanges => "REQUEST_CHANGES",
        };
        let comments: Vec<serde_json::Value> = comments
            .iter()
            .map(|c| {
                let side = match c.side {
                    ReviewSide::Left => "LEFT",
                    ReviewSide::Right => "RIGHT",
                };
                serde_json::json!({ "path": c.path, "line": c.line, "side": side, "body": c.body })
            })
            .collect();
        serde_json::json!({ "commit_id": head_oid, "event": event, "body": body, "comments": comments }).to_string()
    }

    fn read_review_url(&self, stdout: &str) -> Option<String> {
        let read: GhPostedReview = serde_json::from_str(stdout.trim()).ok()?;
        some(read.html_url)
    }

    fn sign_in_exit(&self) -> Option<i32> {
        Some(AUTH_REQUIRED)
    }

    fn credential_fix(&self) -> &'static str {
        CREDENTIAL_FIX
    }
}

/// gh's own code for authentication required, which it has printed since its 2.0 line and which every one of its
/// lines answers with on a computer nobody has signed it in on.
const AUTH_REQUIRED: i32 = 4;

/// The two lines only the person at that computer can run: the sign-in, and the one that hands git the credential
/// gh holds, which is what a push over https reads.
const CREDENTIAL_FIX: &str = "sign gh in on it with gh auth login, then gh auth setup-git";

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// What gh 2.97 printed for PR 870 of Zingzy/wsp on 2026-09-29 with the read's fields, its commits cut to one.
    pub(crate) const VIEW_JSON: &str = r#"{"additions":3369,"baseRefName":"main","changedFiles":95,"commits":[{"authoredDate":"2026-09-26T19:28:02Z","messageHeadline":"an older one","oid":"0000000000000000000000000000000000000001"},{"authoredDate":"2026-09-27T19:28:02Z","messageHeadline":"feat(daemon): commit, discard and save from a pane","oid":"ec5c10de663bd1860925ad42e9580bab4eb1d377"}],"deletions":289,"headRefName":"ticket/batch9-git","headRefOid":"ec5c10de663bd1860925ad42e9580bab4eb1d377","isDraft":false,"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","number":870,"reviewDecision":"CHANGES_REQUESTED","state":"OPEN","url":"https://github.com/Zingzy/wsp/pull/870"}"#;

    /// Its checks as gh pr checks prints them, one Actions job failed, and one check another service reported.
    pub(crate) const CHECKS_JSON: &str = r#"[{"bucket":"fail","description":"","link":"https://github.com/Zingzy/wsp/actions/runs/36495564111/job/109174214002","name":"Install, build, test, types","workflow":"ci"},{"bucket":"pending","description":"","link":"https://github.com/Zingzy/wsp/actions/runs/36495564109/job/109174213692","name":"Format, lint, test, build, wire suite","workflow":"daemon"},{"bucket":"pass","description":"All good","link":"https://ci.example.com/build/7","name":"buildkite/wsp","workflow":""},{"bucket":"skipping","description":"","link":"","name":"deploy","workflow":"ci"},{"bucket":"cancel","description":"","link":"","name":"lint","workflow":"ci"}]"#;

    #[test]
    fn the_lines_gh_is_given_name_the_repository_the_branch_the_base_and_the_head() {
        assert_eq!(GitHub.view_argv("o/r", &Pick::Branch("work")), ["pr", "view", "work", "-R", "o/r", "--json", FIELDS]);
        assert_eq!(GitHub.view_argv("o/r", &Pick::Number(12)), ["pr", "view", "12", "-R", "o/r", "--json", FIELDS]);
        assert_eq!(GitHub.create_argv("main", "work", None, None), ["pr", "create", "--base", "main", "--head", "work", "--fill"]);
        assert_eq!(
            GitHub.create_argv("main", "work", Some("a title"), Some("a body")),
            ["pr", "create", "--base", "main", "--head", "work", "--fill", "--title", "a title", "--body", "a body"]
        );
        assert_eq!(GitHub.checks_argv("o/r", 12), ["pr", "checks", "12", "-R", "o/r", "--json", "name,bucket,link,workflow,description"]);
        assert_eq!(GitHub.behind_argv("o/r", "main", "abc123"), ["api", "repos/o/r/compare/main...abc123", "--jq", ".behind_by"]);
        // A branch name is git's to allow: a `#`, a `%` or a space in it is escaped so the path is not cut there, and a
        // slash stays the separator GitHub reads in a branch name.
        assert_eq!(GitHub.behind_argv("o/r", "release#2", "abc123")[1], "repos/o/r/compare/release%232...abc123");
        assert_eq!(GitHub.behind_argv("o/r", "50% off", "ab")[1], "repos/o/r/compare/50%25%20off...ab");
        assert_eq!(GitHub.behind_argv("o/r", "release/1.0", "ab")[1], "repos/o/r/compare/release/1.0...ab");
        assert_eq!(
            GitHub.page_argv("o/r", 12),
            ["pr", "view", "12", "-R", "o/r", "--json", "title,body,author,updatedAt,commits,reviews,comments,files"]
        );
        assert_eq!(GitHub.line_comments_argv("o/r", 12), ["api", "repos/o/r/pulls/12/comments?per_page=100"]);
        assert_eq!(GitHub.log_argv("o/r", 36, 109), ["run", "view", "36", "-R", "o/r", "--job", "109", "--log-failed"]);
    }

    #[test]
    fn the_start_and_review_lines_name_the_repository_and_the_number_by_argv_alone() {
        assert_eq!(GitHub.issue_argv("o/r", 5), ["issue", "view", "5", "-R", "o/r", "--json", "number,url,title,body,state,comments"]);
        assert_eq!(GitHub.checkout_argv(7), ["pr", "checkout", "7"]);
        assert_eq!(GitHub.diff_argv("o/r", 7), ["pr", "diff", "7", "-R", "o/r"]);
        assert_eq!(GitHub.files_argv("o/r", 7), ["api", "repos/o/r/pulls/7/files?per_page=100"]);
        assert_eq!(GitHub.review_argv("o/r", 7), ["api", "--method", "POST", "repos/o/r/pulls/7/reviews", "--input", "-"]);
        // The fill always stands under a title or a body given, which win over it, as gh's own help says.
        assert_eq!(
            GitHub.create_argv("main", "work", None, Some("Closes #5")),
            ["pr", "create", "--base", "main", "--head", "work", "--fill", "--body", "Closes #5"]
        );
    }

    #[test]
    fn a_read_names_its_author_and_a_fork_with_whether_its_author_allowed_edits() {
        let fork = r#"{"number":14519,"url":"u","state":"OPEN","author":{"login":"waldyrious"},"isCrossRepository":true,"maintainerCanModify":true,"headRepositoryOwner":{"login":"waldyrious"}}"#;
        let read = GitHub.read(fork).unwrap();
        assert_eq!(read.author.as_deref(), Some("waldyrious"));
        assert_eq!(read.fork, Some(PullRequestFork { owner: "waldyrious".into(), pushable: true }));
        let closed = r#"{"number":1,"url":"u","state":"OPEN","isCrossRepository":true,"maintainerCanModify":false,"headRepositoryOwner":{"login":"ana"}}"#;
        assert_eq!(GitHub.read(closed).unwrap().fork, Some(PullRequestFork { owner: "ana".into(), pushable: false }));
        let own = r#"{"number":892,"url":"u","state":"OPEN","author":{"login":"Zingzy"},"isCrossRepository":false,"maintainerCanModify":false,"headRepositoryOwner":{"login":"Zingzy"}}"#;
        assert_eq!(GitHub.read(own).unwrap().fork, None);
    }

    #[test]
    fn an_issue_is_read_off_ghs_json_with_each_comment_by_its_author() {
        let json = r#"{"number":5,"url":"https://github.com/o/r/issues/5","title":"Add a greeting","body":"The first line says hello.","state":"OPEN","comments":[{"author":{"login":"maya"},"authorAssociation":"OWNER","body":"Keep it one line.","createdAt":"2026-09-29T10:00:00Z","id":"IC_1"}]}"#;
        let read = GitHub.read_issue(json).unwrap();
        assert_eq!((read.number, read.title.as_str(), read.state.as_str()), (5, "Add a greeting", "OPEN"));
        assert_eq!(
            read.comments,
            [IssueComment { author: "maya".into(), body: "Keep it one line.".into(), at: "2026-09-29T10:00:00Z".into() }]
        );
        assert!(GitHub.read_issue("not found").is_none());
    }

    #[test]
    fn the_files_walk_reads_each_patch_by_its_path() {
        let json = r#"[{"sha":"a","filename":"check.sh","status":"modified","patch":"@@ -1,3 +1,4 @@\n a\n+b\n c\n d"},{"sha":"b","filename":"logo.png","status":"added"}]"#;
        let files = GitHub.read_files(json).unwrap();
        assert_eq!(files, [("check.sh".to_owned(), "@@ -1,3 +1,4 @@\n a\n+b\n c\n d".to_owned()), ("logo.png".to_owned(), String::new())]);
        assert_eq!(
            GitHub
                .read_review_url(r#"{"id":1,"state":"COMMENTED","html_url":"https://github.com/o/r/pull/7#pullrequestreview-1"}"#)
                .as_deref(),
            Some("https://github.com/o/r/pull/7#pullrequestreview-1")
        );
    }

    #[test]
    fn a_merge_carries_the_method_and_the_head_the_person_saw_and_auto_only_when_asked() {
        assert_eq!(
            GitHub.merge_argv("o/r", 12, MergeMethod::Squash, false, "abc123"),
            ["pr", "merge", "12", "-R", "o/r", "--squash", "--match-head-commit", "abc123"]
        );
        assert_eq!(
            GitHub.merge_argv("o/r", 12, MergeMethod::Merge, true, "abc123"),
            ["pr", "merge", "12", "-R", "o/r", "--merge", "--auto", "--match-head-commit", "abc123"]
        );
        assert_eq!(GitHub.merge_argv("o/r", 3, MergeMethod::Rebase, false, "f")[5], "--rebase");
        assert_eq!(GitHub.read_merged(r#"{"state":"MERGED","autoMergeRequest":null}"#), Some((true, false)));
        assert_eq!(GitHub.read_merged(r#"{"state":"OPEN","autoMergeRequest":{"mergeMethod":"SQUASH"}}"#), Some((false, true)));
        assert_eq!(GitHub.read_merged(r#"{"state":"OPEN","autoMergeRequest":null}"#), Some((false, false)));
    }

    #[test]
    fn the_lists_gh_is_given_ask_for_open_items_by_argv_alone() {
        assert_eq!(
            GitHub.list_argv(HostItemKind::PullRequest),
            ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,url"]
        );
        assert_eq!(
            GitHub.list_argv(HostItemKind::Issue),
            ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,url"]
        );
    }

    #[test]
    fn a_list_is_read_off_ghs_json_with_each_body_cut_at_the_cap() {
        let long = "x".repeat(numbers::GIT_PR_LIST_BODY_CAP + 10);
        let json = format!(
            "[{{\"number\":42,\"title\":\"Login breaks on Safari\",\"body\":\"{long}\",\"url\":\"https://github.com/o/r/pull/42\"}},{{\"number\":3,\"title\":\"t\",\"body\":\"\",\"url\":\"u\"}}]"
        );
        let read = GitHub.read_list(HostItemKind::PullRequest, &json).unwrap();
        assert_eq!((read[0].number, read[0].title.as_str(), read[0].kind), (42, "Login breaks on Safari", HostItemKind::PullRequest));
        assert_eq!(read[0].body.chars().count(), numbers::GIT_PR_LIST_BODY_CAP + 1);
        assert!(read[0].body.ends_with('…'));
        assert_eq!(read[1].body, "");
        assert!(GitHub.read_list(HostItemKind::Issue, "no issues").is_none());
    }

    #[test]
    fn the_sign_in_code_is_ghs_own_and_the_fix_names_the_two_commands_only_the_person_can_run() {
        assert_eq!(GitHub.sign_in_exit(), Some(4));
        assert_eq!(GitHub.credential_fix(), "sign gh in on it with gh auth login, then gh auth setup-git");
    }

    #[test]
    fn the_pull_request_is_read_off_ghs_json_and_never_off_its_prose() {
        let read = GitHub.read(VIEW_JSON).unwrap();
        assert_eq!((read.number, read.state, read.host.as_str()), (870, PullRequestState::Open, "github.com"));
        assert_eq!(read.url, "https://github.com/Zingzy/wsp/pull/870");
        assert_eq!((read.base.as_str(), read.branch.as_str()), ("main", "ticket/batch9-git"));
        assert_eq!(read.head_oid, "ec5c10de663bd1860925ad42e9580bab4eb1d377");
        // The head's own subject where the list holds the head, else the last commit's.
        assert_eq!(read.head_subject, "feat(daemon): commit, discard and save from a pane");
        assert_eq!((read.mergeable, read.merge_state.as_str(), read.review), (Mergeable::Mergeable, "blocked", ReviewState::ChangesAsked));
        assert_eq!((read.additions, read.deletions, read.changed_files, read.commits, read.draft), (3369, 289, 95, 2, false));
        assert_eq!(GitHub.read(r#"{"number":1,"url":"u","state":"MERGED"}"#).unwrap().state, PullRequestState::Merged);
        let closed = GitHub
            .read(r#"{"number":1,"url":"u","state":"CLOSED","mergeable":"CONFLICTING","reviewDecision":"REVIEW_REQUIRED","isDraft":true}"#)
            .unwrap();
        assert_eq!(
            (closed.state, closed.mergeable, closed.review, closed.draft),
            (PullRequestState::Closed, Mergeable::Conflicting, ReviewState::Required, true)
        );
        let bare = GitHub.read(r#"{"number":1,"url":"u","state":"OPEN","mergeable":"UNKNOWN","reviewDecision":""}"#).unwrap();
        assert_eq!((bare.mergeable, bare.review), (Mergeable::Unknown, ReviewState::None));
        assert!(GitHub.read("https://github.com/o/r/pull/12\n").is_none());
        assert!(GitHub.read(r#"{"number":1,"url":"u","state":"DRAFTED"}"#).is_none());
        assert!(GitHub.read("").is_none());
    }

    #[test]
    fn each_check_is_one_word_and_an_actions_job_carries_its_run_and_job() {
        let checks = GitHub.read_checks(CHECKS_JSON).unwrap();
        let states: Vec<CheckState> = checks.iter().map(|c| c.state).collect();
        assert_eq!(states, [CheckState::Fail, CheckState::Pending, CheckState::Pass, CheckState::Skipped, CheckState::Cancelled]);
        assert_eq!(checks[0].run, Some(PullRequestCheckRun { run_id: 36495564111, job_id: 109174214002 }));
        assert_eq!((checks[0].workflow.as_deref(), checks[0].description.as_deref()), (Some("ci"), None));
        // A check another service reports has its link and its words and no run to read a log from.
        assert_eq!((checks[2].run, checks[2].link.as_deref()), (None, Some("https://ci.example.com/build/7")));
        assert_eq!((checks[2].workflow.as_deref(), checks[2].description.as_deref()), (None, Some("All good")));
        assert_eq!((checks[3].link.as_deref(), checks[3].run), (None, None));
        assert!(GitHub.read_checks("no checks reported on the 'work' branch").is_none());
        assert_eq!(run_of("https://github.com/o/r/actions/runs/12/job/34?pr=5"), Some(PullRequestCheckRun { run_id: 12, job_id: 34 }));
        assert_eq!(run_of("https://github.com/o/r/actions/runs/12"), None);
    }

    #[test]
    fn a_page_reads_its_parts_and_a_line_comment_off_the_rest_api_with_its_line_or_the_one_it_was_on() {
        let page = r#"{"title":"Round the total","body":"Why it changed","author":{"login":"cid"},"updatedAt":"2026-09-28T13:00:00Z","commits":[{"oid":"abc","messageHeadline":"Round once","committedDate":"2026-09-28T10:00:00Z","authors":[{"name":"Dana","email":"d@e","login":"dana"}]},{"oid":"def","messageHeadline":"Fix","committedDate":"2026-09-28T10:01:00Z","authors":[{"name":"Eli","email":"e@e","login":""}]}],"reviews":[{"author":{"login":"ana"},"state":"CHANGES_REQUESTED","body":"see line 3","submittedAt":"2026-09-28T11:00:00Z"}],"comments":[{"author":{"login":"bo"},"body":"thanks","createdAt":"2026-09-28T12:00:00Z"}],"files":[{"path":"check.sh","additions":2,"deletions":1}]}"#;
        let lines = r#"[{"id":7,"path":"check.sh","line":3,"original_line":3,"side":"RIGHT","user":{"login":"ana"},"body":"exit 1 here","html_url":"https://github.com/o/r/pull/12#discussion_r7","created_at":"2026-09-28T11:00:00Z"},{"id":8,"path":"old.sh","line":null,"original_line":9,"side":"LEFT","user":{"login":"ana"},"body":"gone","html_url":"u","created_at":"t"}]"#;
        let read = GitHub.read_page(page, lines).unwrap();
        assert_eq!((read.title.as_str(), read.body.as_str()), ("Round the total", "Why it changed"));
        assert_eq!((read.author.as_str(), read.updated_at.as_str()), ("cid", "2026-09-28T13:00:00Z"));
        assert_eq!(
            read.commits,
            [
                PullRequestCommit {
                    oid: "abc".into(),
                    subject: "Round once".into(),
                    at: "2026-09-28T10:00:00Z".into(),
                    author: "dana".into()
                },
                PullRequestCommit { oid: "def".into(), subject: "Fix".into(), at: "2026-09-28T10:01:00Z".into(), author: "Eli".into() }
            ]
        );
        assert_eq!((read.reviews[0].author.as_str(), read.reviews[0].state.as_str()), ("ana", "changes_requested"));
        assert_eq!((read.comments[0].author.as_str(), read.comments[0].body.as_str()), ("bo", "thanks"));
        assert_eq!(read.files, [PullRequestFile { path: "check.sh".into(), additions: 2, deletions: 1 }]);
        assert_eq!((read.review_comments[0].line, read.review_comments[0].side.as_deref()), (Some(3), Some("RIGHT")));
        assert_eq!(read.review_comments[1].line, Some(9));
        assert_eq!(read.review_comments[0].url, "https://github.com/o/r/pull/12#discussion_r7");
        assert!(GitHub.read_page(page, "Not Found").is_none());
    }

    #[test]
    fn the_repository_says_its_methods_its_default_and_whether_it_merges_by_itself() {
        let all = r#"{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"viewerDefaultMergeMethod":"MERGE"}"#;
        let read = GitHub.read_repo(all, "false\n").unwrap();
        assert_eq!(
            (read.methods, read.default_method, read.auto_merge),
            (vec![MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase], MergeMethod::Merge, false)
        );
        // A default the repository no longer allows falls to the first it does.
        let squash =
            r#"{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"viewerDefaultMergeMethod":"MERGE"}"#;
        let read = GitHub.read_repo(squash, "true").unwrap();
        assert_eq!((read.methods, read.default_method, read.auto_merge), (vec![MergeMethod::Squash], MergeMethod::Squash, true));
        assert!(GitHub.read_repo(r#"{"mergeCommitAllowed":false}"#, "true").is_none());
        assert_eq!(
            GitHub.repo_argv("o/r"),
            ["repo", "view", "o/r", "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod"]
        );
        assert_eq!(GitHub.auto_merge_argv("o/r"), ["api", "repos/o/r", "--jq", ".allow_auto_merge"]);
    }
}
