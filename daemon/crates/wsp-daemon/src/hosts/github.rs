// SPDX-License-Identifier: AGPL-3.0-only
//! GitHub through gh, the command line the image signs in once: `gh pr view --json` for what is there and
//! `gh pr create` for what is not, `gh pr checks` and `gh api` for the checks and the counts, `gh run view` for a
//! failed job's log and `gh pr merge` for a merge, each told the repository with `-R` rather than reading it off a
//! checkout.

use serde::de::IgnoredAny;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

use wsp_frames::{
    numbers, CheckState, GitPrReplyReply, GitPrResolveReply, GitPrViewReply, GitRepoReadReply, HostItem, HostItemKind, IssueComment,
    IssueRead, MergeMethod, Mergeable, PullRequest, PullRequestAutoMerge, PullRequestCheck, PullRequestCheckRun, PullRequestComment,
    PullRequestCommit, PullRequestFile, PullRequestFork, PullRequestLabel, PullRequestPageCut, PullRequestReaction, PullRequestReview,
    PullRequestReviewComment, PullRequestReviewRequest, PullRequestState, PullRequestVerdict, ReactionContent, ReviewComment, ReviewEvent,
    ReviewSide, ReviewState,
};

use super::{Pick, PullRequests};

pub(crate) struct GitHub;

/// The fields a read asks gh for, in gh's own spelling.
const FIELDS: &str = "number,url,state,updatedAt,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,additions,deletions,changedFiles,commits,author,isCrossRepository,maintainerCanModify,headRepositoryOwner,autoMergeRequest";

/// The three fields of a read's JSON that say whether the pull request moved.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhSeen {
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    head_ref_oid: String,
    #[serde(default)]
    state: String,
}

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
    auto_merge_request: Option<GhAutoMerge>,
}

/// A merge armed to land once the checks pass.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhAutoMerge {
    #[serde(default)]
    merge_method: String,
    enabled_by: Option<GhLogin>,
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
const CHECK_FIELDS: &str = "name,bucket,link,workflow,description,startedAt,completedAt";

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
    #[serde(default, rename = "startedAt")]
    started_at: String,
    #[serde(default, rename = "completedAt")]
    completed_at: String,
}

/// The one GraphQL read a pull request's page is. It asks the first 100 comments of each thread because a reply is
/// found in its thread by its own id, not its root's, and the newest 100 reviews, threads and comments where gh's
/// commits and files lists stop at the first 100, as gh's own `pr view` did. Each list says whether there was more than
/// it read.
const PAGE_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { title body author { login } createdAt updatedAt closedAt mergedAt mergedBy { login } mergeCommit { oid } labels(first: 100) { nodes { name color description } } reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug name organization { login } } ... on Bot { login } ... on Mannequin { login } } } } latestReviews(first: 100) { nodes { author { login } state submittedAt } } assignees(first: 100) { nodes { login } } commits(first: 100) { totalCount nodes { commit { oid messageHeadline messageBody committedDate author { name user { login } } additions deletions parents { totalCount } statusCheckRollup { state } } } } reviews(last: 100) { pageInfo { hasPreviousPage } nodes { id databaseId author { login } authorAssociation state body submittedAt reactionGroups { content viewerHasReacted reactors { totalCount } } } } files(first: 100) { nodes { path additions deletions } } comments(last: 100) { pageInfo { hasPreviousPage } nodes { id databaseId author { __typename login avatarUrl } authorAssociation body url createdAt reactionGroups { content viewerHasReacted reactors { totalCount } } } } reviewThreads(last: 100) { pageInfo { hasPreviousPage } nodes { id isResolved path diffSide comments(first: 100) { nodes { id databaseId author { __typename login avatarUrl } authorAssociation body url createdAt diffHunk line originalLine replyTo { databaseId } pullRequestReview { databaseId } reactionGroups { content viewerHasReacted reactors { totalCount } } } } } } } } }";

#[derive(Deserialize)]
struct GhLogin {
    #[serde(default)]
    login: String,
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
struct GhLabel {
    name: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRequest {
    requested_reviewer: Option<GhRequested>,
}

/// A review asked for: a person, or a team, which has a slug and no login.
#[derive(Deserialize)]
struct GhRequested {
    #[serde(default, rename = "__typename")]
    kind: String,
    #[serde(default)]
    login: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    name: String,
    organization: Option<GhLogin>,
}

#[derive(Deserialize)]
struct GhOid {
    #[serde(default)]
    oid: String,
}

/// Who wrote a comment as the REST API says it: the login, whether it is a person or a bot, and the face it shows.
#[derive(Deserialize)]
struct GhUser {
    #[serde(default)]
    login: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    avatar_url: String,
}

/// Who, whether a bot, and the face, off a REST comment's user; a deleted account is nobody, no bot and no face.
fn user_of(user: Option<GhUser>) -> (String, bool, Option<String>) {
    user.map_or_else(|| (String::new(), false, None), |u| (u.login, u.kind == "Bot", some(u.avatar_url)))
}

/// Who wrote a comment as the GraphQL API says it, whose `__typename` says whether it is a bot.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhAuthor {
    #[serde(default, rename = "__typename")]
    kind: String,
    #[serde(default)]
    login: String,
    #[serde(default)]
    avatar_url: String,
}

/// Who, whether a bot, and the face, off a GraphQL comment's author. A bot's login carries the `[bot]` the REST API
/// spells it with and GraphQL leaves off; a deleted account is nobody, no bot and no face.
fn author_of(author: Option<GhAuthor>) -> (String, bool, Option<String>) {
    author.map_or_else(
        || (String::new(), false, None),
        |a| {
            let bot = a.kind == "Bot";
            (if bot { format!("{}[bot]", a.login) } else { a.login }, bot, some(a.avatar_url))
        },
    )
}

/// The counts of the eight reactions as the REST API gives them on a comment.
#[derive(Deserialize)]
struct GhRestReactions {
    #[serde(default, rename = "+1")]
    thumbs_up: u64,
    #[serde(default, rename = "-1")]
    thumbs_down: u64,
    #[serde(default)]
    laugh: u64,
    #[serde(default)]
    hooray: u64,
    #[serde(default)]
    confused: u64,
    #[serde(default)]
    heart: u64,
    #[serde(default)]
    rocket: u64,
    #[serde(default)]
    eyes: u64,
}

impl GhRestReactions {
    fn counts(&self) -> [(ReactionContent, u64); 8] {
        [
            (ReactionContent::ThumbsUp, self.thumbs_up),
            (ReactionContent::ThumbsDown, self.thumbs_down),
            (ReactionContent::Laugh, self.laugh),
            (ReactionContent::Hooray, self.hooray),
            (ReactionContent::Confused, self.confused),
            (ReactionContent::Heart, self.heart),
            (ReactionContent::Rocket, self.rocket),
            (ReactionContent::Eyes, self.eyes),
        ]
    }
}

/// One reaction group as the GraphQL API gives it: which, whether the signed-in person left it, and, where asked, how
/// many did.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhViewerReaction {
    #[serde(default)]
    content: String,
    #[serde(default)]
    viewer_has_reacted: bool,
    reactors: Option<GhCount>,
}

/// The GraphQL API's word for a reaction, in the REST API's names the protocol carries.
fn reaction_of(word: &str) -> Option<ReactionContent> {
    Some(match word {
        "THUMBS_UP" => ReactionContent::ThumbsUp,
        "THUMBS_DOWN" => ReactionContent::ThumbsDown,
        "LAUGH" => ReactionContent::Laugh,
        "HOORAY" => ReactionContent::Hooray,
        "CONFUSED" => ReactionContent::Confused,
        "HEART" => ReactionContent::Heart,
        "ROCKET" => ReactionContent::Rocket,
        "EYES" => ReactionContent::Eyes,
        _ => return None,
    })
}

/// The GraphQL API's word for a reaction the protocol names.
fn reaction_word(content: ReactionContent) -> &'static str {
    match content {
        ReactionContent::ThumbsUp => "THUMBS_UP",
        ReactionContent::ThumbsDown => "THUMBS_DOWN",
        ReactionContent::Laugh => "LAUGH",
        ReactionContent::Hooray => "HOORAY",
        ReactionContent::Confused => "CONFUSED",
        ReactionContent::Heart => "HEART",
        ReactionContent::Rocket => "ROCKET",
        ReactionContent::Eyes => "EYES",
    }
}

/// The reactions an item carries, GitHub's order kept: each one somebody left, with whether the signed-in person is
/// one of them; nothing where nobody reacted.
fn reactions_of(
    counts: impl IntoIterator<Item = (ReactionContent, u64)>,
    mine: Option<&HashSet<ReactionContent>>,
) -> Option<Vec<PullRequestReaction>> {
    let listed: Vec<PullRequestReaction> = counts
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(content, count)| PullRequestReaction { content, count, mine: mine.is_some_and(|m| m.contains(&content)) })
        .collect();
    (!listed.is_empty()).then_some(listed)
}

/// The reactions on an item off its GraphQL groups, each one's count and whether the signed-in person left it.
fn counted(groups: &[GhViewerReaction]) -> Option<Vec<PullRequestReaction>> {
    let mine = mine_of(groups);
    reactions_of(
        groups.iter().filter_map(|g| Some((reaction_of(&g.content)?, g.reactors.as_ref().map_or(0, |r| r.total_count)))),
        Some(&mine),
    )
}

/// Which reactions the signed-in person left, by the node id of what they reacted to.
type Mine = HashMap<String, HashSet<ReactionContent>>;

fn mine_of(groups: &[GhViewerReaction]) -> HashSet<ReactionContent> {
    groups.iter().filter(|g| g.viewer_has_reacted).filter_map(|g| reaction_of(&g.content)).collect()
}

/// The review thread each comment on a line is in, by the comment's id: the thread's node id and whether it is resolved.
type Threads = HashMap<u64, (String, bool)>;

/// A comment in the conversation as the REST API answered with it.
fn comment_of(c: GhIssueComment, mine: &Mine) -> PullRequestComment {
    let (author, bot, avatar) = user_of(c.user);
    PullRequestComment {
        reactions: c.reactions.and_then(|r| reactions_of(r.counts(), mine.get(&c.node_id))),
        id: c.id,
        node_id: some(c.node_id),
        author,
        association: association_of(c.author_association),
        bot,
        avatar,
        body: c.body.trim().to_owned(),
        url: c.html_url,
        at: c.created_at,
    }
}

/// A comment on a line as the REST API answered with it, its thread found by its own id or by the comment it answers.
fn line_comment_of(c: GhLineComment, threads: &Threads, mine: &Mine) -> PullRequestReviewComment {
    let (author, bot, avatar) = user_of(c.user);
    let thread = threads.get(&c.id).or_else(|| c.in_reply_to_id.and_then(|root| threads.get(&root)));
    PullRequestReviewComment {
        reactions: c.reactions.and_then(|r| reactions_of(r.counts(), mine.get(&c.node_id))),
        resolved: thread.map(|(_, resolved)| *resolved),
        thread_id: thread.map(|(id, _)| id.clone()),
        association: association_of(c.author_association),
        id: c.id,
        node_id: some(c.node_id),
        path: c.path,
        line: c.line.or(c.original_line),
        side: c.side,
        author,
        bot,
        avatar,
        body: c.body.trim().to_owned(),
        url: c.html_url,
        at: c.created_at,
        hunk: c.diff_hunk.and_then(some),
        reply_to: c.in_reply_to_id,
        review_id: c.pull_request_review_id,
    }
}

/// The REST API's JSON for one comment in a pull request's conversation, which says who is a bot where gh's does not.
#[derive(Deserialize)]
struct GhIssueComment {
    id: u64,
    #[serde(default)]
    node_id: String,
    reactions: Option<GhRestReactions>,
    user: Option<GhUser>,
    #[serde(default)]
    author_association: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    created_at: String,
}

/// The REST API's JSON for one comment on a line; it is not in gh's pull request JSON at all.
#[derive(Deserialize)]
struct GhLineComment {
    id: u64,
    #[serde(default)]
    node_id: String,
    reactions: Option<GhRestReactions>,
    path: String,
    line: Option<u64>,
    original_line: Option<u64>,
    side: Option<String>,
    user: Option<GhUser>,
    #[serde(default)]
    author_association: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    created_at: String,
    diff_hunk: Option<String>,
    in_reply_to_id: Option<u64>,
    pull_request_review_id: Option<u64>,
}

/// The page's GraphQL read, down to the pull request.
#[derive(Deserialize)]
struct GhGraph {
    data: Option<GhGraphData>,
}

#[derive(Deserialize)]
struct GhGraphData {
    repository: Option<GhGraphRepo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhGraphRepo {
    pull_request: Option<GhGraphPr>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhGraphPr {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    author: Option<GhLogin>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    closed_at: Option<String>,
    merged_at: Option<String>,
    merged_by: Option<GhLogin>,
    merge_commit: Option<GhOid>,
    #[serde(default)]
    labels: GhNodes<GhLabel>,
    #[serde(default)]
    review_requests: GhNodes<GhRequest>,
    #[serde(default)]
    latest_reviews: GhNodes<GhGraphReview>,
    #[serde(default)]
    assignees: GhNodes<GhLogin>,
    #[serde(default)]
    commits: GhNodes<GhGraphCommitNode>,
    #[serde(default)]
    reviews: GhNodes<GhGraphReview>,
    #[serde(default)]
    files: GhNodes<GhFile>,
    #[serde(default)]
    comments: GhNodes<GhGraphComment>,
    #[serde(default)]
    review_threads: GhNodes<GhGraphThread>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhNodes<T> {
    #[serde(default = "Vec::new")]
    nodes: Vec<T>,
    total_count: Option<u64>,
    page_info: Option<GhPageInfo>,
}

impl<T> GhNodes<T> {
    /// Whether the connection holds more before what was read.
    fn more_before(&self) -> bool {
        self.page_info.as_ref().is_some_and(|p| p.has_previous_page)
    }
}

impl<T> Default for GhNodes<T> {
    fn default() -> Self {
        GhNodes { nodes: Vec::new(), total_count: None, page_info: None }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPageInfo {
    #[serde(default)]
    has_previous_page: bool,
}

#[derive(Deserialize)]
struct GhGraphCommitNode {
    commit: GhGraphCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhGraphCommit {
    oid: String,
    #[serde(default)]
    message_headline: String,
    #[serde(default)]
    message_body: String,
    #[serde(default)]
    committed_date: String,
    author: Option<GhGitActor>,
    additions: Option<u64>,
    deletions: Option<u64>,
    parents: Option<GhCount>,
    status_check_rollup: Option<GhRollup>,
}

/// A commit's git author: the name it was made under, and the account GitHub matched it to where it did.
#[derive(Deserialize)]
struct GhGitActor {
    #[serde(default)]
    name: String,
    user: Option<GhLogin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhCount {
    total_count: u64,
}

#[derive(Deserialize)]
struct GhRollup {
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhGraphReview {
    #[serde(default)]
    id: String,
    database_id: Option<u64>,
    author: Option<GhLogin>,
    #[serde(default)]
    author_association: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    submitted_at: Option<String>,
    #[serde(default)]
    reaction_groups: Vec<GhViewerReaction>,
}

/// A comment off the GraphQL read, in the conversation or on a line; only one on a line has a hunk, lines, the comment
/// it answers and its review.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhGraphComment {
    #[serde(default)]
    id: String,
    database_id: Option<u64>,
    author: Option<GhAuthor>,
    #[serde(default)]
    author_association: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    created_at: String,
    diff_hunk: Option<String>,
    line: Option<u64>,
    original_line: Option<u64>,
    reply_to: Option<GhDatabaseId>,
    pull_request_review: Option<GhDatabaseId>,
    #[serde(default)]
    reaction_groups: Vec<GhViewerReaction>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhDatabaseId {
    database_id: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhGraphThread {
    #[serde(default)]
    id: String,
    is_resolved: bool,
    #[serde(default)]
    path: String,
    diff_side: Option<String>,
    #[serde(default)]
    comments: GhNodes<GhGraphComment>,
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

/// The two mutations a review thread is resolved and unresolved by, and the two a reaction is added and taken off by,
/// each naming what it acts on as a variable so nothing a person or the page sent is spliced into the query.
/// The read a resolve or a reaction makes first: which pull request, in which repository, the node it names sits on.
const SCOPE_QUERY: &str = "query($id: ID!) { node(id: $id) { __typename ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } ... on PullRequestReviewComment { pullRequest { number repository { nameWithOwner } } } ... on PullRequestReview { pullRequest { number repository { nameWithOwner } } } ... on IssueComment { pullRequest { number repository { nameWithOwner } } } } }";

/// What that read answered: the node's kind and its pull request, where it sits on one.
#[derive(Deserialize)]
struct GhScope {
    data: Option<GhScopeData>,
}

#[derive(Deserialize)]
struct GhScopeData {
    node: Option<GhScopeNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhScopeNode {
    #[serde(default, rename = "__typename")]
    kind: String,
    pull_request: Option<GhScopePr>,
}

#[derive(Deserialize)]
struct GhScopePr {
    number: u64,
    repository: GhScopeRepo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhScopeRepo {
    name_with_owner: String,
}

const RESOLVE_MUTATION: &str = "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }";
const UNRESOLVE_MUTATION: &str = "mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }";
const REACT_MUTATION: &str = "mutation($id: ID!, $content: ReactionContent!) { addReaction(input: {subjectId: $id, content: $content}) { subject { reactionGroups { content viewerHasReacted reactors { totalCount } } } } }";
const UNREACT_MUTATION: &str = "mutation($id: ID!, $content: ReactionContent!) { removeReaction(input: {subjectId: $id, content: $content}) { subject { reactionGroups { content viewerHasReacted reactors { totalCount } } } } }";

/// What a resolve or an unresolve answered with, under whichever of the two mutations ran.
#[derive(Deserialize)]
struct GhResolved {
    data: Option<GhResolvedData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhResolvedData {
    resolve_review_thread: Option<GhThreadPayload>,
    unresolve_review_thread: Option<GhThreadPayload>,
}

#[derive(Deserialize)]
struct GhThreadPayload {
    thread: GhThreadState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhThreadState {
    id: String,
    is_resolved: bool,
}

/// What a reaction added or taken off answered with: every reaction group on the item now.
#[derive(Deserialize)]
struct GhReacted {
    data: Option<GhReactedData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReactedData {
    add_reaction: Option<GhReactionPayload>,
    remove_reaction: Option<GhReactionPayload>,
}

#[derive(Deserialize)]
struct GhReactionPayload {
    subject: GhReactedSubject,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhReactedSubject {
    #[serde(default)]
    reaction_groups: Vec<GhViewerReaction>,
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

/// An author's association with the repository in lower case, absent where the host answered none.
fn association_of(word: String) -> Option<String> {
    some(word.to_ascii_lowercase())
}

/// A commit's checks rolled into one word by the API; a word a later API adds reads as still running.
fn rollup_of(word: &str) -> CheckState {
    match word {
        "SUCCESS" => CheckState::Pass,
        "FAILURE" | "ERROR" => CheckState::Fail,
        _ => CheckState::Pending,
    }
}

/// A time gh printed, absent where it printed Go's zero time for one that has not come.
fn time_of(at: String) -> Option<String> {
    some(at).filter(|at| !at.starts_with("0001-"))
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

fn commit_author(author: Option<GhGitActor>) -> String {
    author.map(|a| a.user.map(|u| u.login).filter(|login| !login.is_empty()).unwrap_or(a.name)).unwrap_or_default()
}

/// The words a read compares to ask whether a pull request moved. REST says open or closed where GraphQL says OPEN,
/// CLOSED or MERGED, so the state is folded to the two words REST has.
fn seen_of(updated: &str, head: &str, state: &str) -> String {
    format!("{updated} {head} {}", if state.eq_ignore_ascii_case("open") { "open" } else { "closed" })
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
            auto_merge: read.auto_merge_request.and_then(|a| {
                Some(PullRequestAutoMerge { method: method_of(&a.merge_method)?, by: a.enabled_by.map(|b| b.login).and_then(some) })
            }),
        })
    }

    fn probe_argv(&self, repo: &str, number: u64) -> Vec<String> {
        words(&["api", &format!("repos/{repo}/pulls/{number}"), "--jq", r#""\(.updated_at) \(.head.sha) \(.state)""#])
    }

    fn read_probe(&self, stdout: &str) -> Option<String> {
        let mut words = stdout.split_whitespace();
        let (updated, head, state) = (words.next()?, words.next()?, words.next()?);
        Some(seen_of(updated, head, state))
    }

    fn seen(&self, view: &str) -> Option<String> {
        let read: GhSeen = serde_json::from_str(view.trim()).ok()?;
        (!read.updated_at.is_empty()).then(|| seen_of(&read.updated_at, &read.head_ref_oid, &read.state))
    }

    fn rate_limited(&self, said: &str) -> bool {
        said.to_ascii_lowercase().contains("rate limit")
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
                    started_at: time_of(c.started_at),
                    completed_at: time_of(c.completed_at),
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
        let (owner, name) = repo.split_once('/').unwrap_or((repo, ""));
        let query = format!("query={PAGE_QUERY}");
        let (owner, name, number) = (format!("owner={owner}"), format!("name={name}"), format!("number={number}"));
        words(&["api", "graphql", "-f", &query, "-f", &owner, "-f", &name, "-F", &number])
    }

    fn read_page(&self, stdout: &str) -> Option<GitPrViewReply> {
        let read: GhGraph = serde_json::from_str(stdout.trim()).ok()?;
        let pr = read.data?.repository?.pull_request?;
        let cut = PullRequestPageCut {
            commits: pr.commits.total_count.is_some_and(|total| total > pr.commits.nodes.len() as u64).then_some(true),
            reviews: pr.reviews.more_before().then_some(true),
            threads: pr.review_threads.more_before().then_some(true),
            comments: pr.comments.more_before().then_some(true),
        };
        let mut review_comments = Vec::new();
        for t in pr.review_threads.nodes {
            for c in t.comments.nodes {
                let (author, bot, avatar) = author_of(c.author);
                review_comments.push(PullRequestReviewComment {
                    reactions: counted(&c.reaction_groups),
                    resolved: Some(t.is_resolved),
                    thread_id: some(t.id.clone()),
                    association: association_of(c.author_association),
                    id: c.database_id.unwrap_or_default(),
                    node_id: some(c.id),
                    path: t.path.clone(),
                    line: c.line.or(c.original_line),
                    side: t.diff_side.clone(),
                    author,
                    bot,
                    avatar,
                    body: c.body.trim().to_owned(),
                    url: c.url,
                    at: c.created_at,
                    hunk: c.diff_hunk.and_then(some),
                    reply_to: c.reply_to.and_then(|r| r.database_id),
                    review_id: c.pull_request_review.and_then(|r| r.database_id),
                });
            }
        }
        review_comments.sort_by_key(|c| c.id);
        Some(GitPrViewReply {
            title: pr.title,
            body: pr.body.trim().to_owned(),
            author: login(pr.author),
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            closed_at: pr.closed_at.and_then(some),
            merged_at: pr.merged_at.and_then(some),
            merged_by: pr.merged_by.map(|m| m.login).and_then(some),
            merge_commit: pr.merge_commit.map(|m| m.oid).and_then(some),
            labels: pr
                .labels
                .nodes
                .into_iter()
                .map(|l| PullRequestLabel { name: l.name, color: l.color, description: some(l.description) })
                .collect(),
            review_requests: pr
                .review_requests
                .nodes
                .into_iter()
                .filter_map(|r| r.requested_reviewer)
                .map(|r| {
                    let team = r.kind == "Team";
                    let name = if !team {
                        r.login
                    } else if r.slug.is_empty() {
                        r.name
                    } else {
                        match r.organization {
                            Some(org) if !org.login.is_empty() => format!("{}/{}", org.login, r.slug),
                            _ => r.slug,
                        }
                    };
                    PullRequestReviewRequest { name, team }
                })
                .collect(),
            latest_reviews: pr
                .latest_reviews
                .nodes
                .into_iter()
                .map(|r| PullRequestVerdict {
                    author: login(r.author),
                    state: r.state.to_ascii_lowercase(),
                    at: r.submitted_at.unwrap_or_default(),
                })
                .collect(),
            assignees: pr.assignees.nodes.into_iter().map(|a| a.login).collect(),
            commits: pr
                .commits
                .nodes
                .into_iter()
                .map(|n| PullRequestCommit {
                    subject: n.commit.message_headline,
                    body: n.commit.message_body,
                    at: n.commit.committed_date,
                    author: commit_author(n.commit.author),
                    parents: n.commit.parents.map(|p| p.total_count),
                    additions: n.commit.additions,
                    deletions: n.commit.deletions,
                    check: n.commit.status_check_rollup.map(|r| rollup_of(&r.state)),
                    oid: n.commit.oid,
                })
                .collect(),
            reviews: pr
                .reviews
                .nodes
                .into_iter()
                .map(|r| PullRequestReview {
                    id: r.database_id,
                    reactions: counted(&r.reaction_groups),
                    node_id: some(r.id),
                    association: association_of(r.author_association),
                    author: login(r.author),
                    state: r.state.to_ascii_lowercase(),
                    body: r.body.trim().to_owned(),
                    at: r.submitted_at.unwrap_or_default(),
                })
                .collect(),
            comments: pr
                .comments
                .nodes
                .into_iter()
                .map(|c| {
                    let (author, bot, avatar) = author_of(c.author);
                    PullRequestComment {
                        reactions: counted(&c.reaction_groups),
                        id: c.database_id.unwrap_or_default(),
                        node_id: some(c.id),
                        author,
                        association: association_of(c.author_association),
                        bot,
                        avatar,
                        body: c.body.trim().to_owned(),
                        url: c.url,
                        at: c.created_at,
                    }
                })
                .collect(),
            review_comments,
            files: pr
                .files
                .nodes
                .into_iter()
                .map(|f| PullRequestFile { path: f.path, additions: f.additions, deletions: f.deletions })
                .collect(),
            cut: (cut != PullRequestPageCut::default()).then_some(cut),
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

    fn reply_argv(&self, repo: &str, number: u64, reply_to: Option<u64>) -> Vec<String> {
        let path = match reply_to {
            Some(id) => format!("repos/{repo}/pulls/{number}/comments/{id}/replies"),
            None => format!("repos/{repo}/issues/{number}/comments"),
        };
        words(&["api", "--method", "POST", &path, "--input", "-"])
    }

    fn reply_input(&self, body: &str) -> String {
        serde_json::json!({ "body": body }).to_string()
    }

    fn read_reply(&self, stdout: &str, on_a_line: bool, thread_id: Option<&str>) -> Option<GitPrReplyReply> {
        let mine = Mine::new();
        Some(if on_a_line {
            let read: GhLineComment = serde_json::from_str(stdout.trim()).ok()?;
            let threads: Threads = thread_id.map(|t| (read.id, (t.to_owned(), false))).into_iter().collect();
            GitPrReplyReply { comment: None, review_comment: Some(line_comment_of(read, &threads, &mine)) }
        } else {
            let read: GhIssueComment = serde_json::from_str(stdout.trim()).ok()?;
            GitPrReplyReply { comment: Some(comment_of(read, &mine)), review_comment: None }
        })
    }

    fn scope_argv(&self, id: &str) -> Vec<String> {
        words(&["api", "graphql", "-f", &format!("query={SCOPE_QUERY}"), "-f", &format!("id={id}")])
    }

    fn read_scope(&self, stdout: &str, thread: bool) -> Option<(String, u64)> {
        let read: GhScope = serde_json::from_str(stdout.trim()).ok()?;
        let node = read.data?.node?;
        let kinds: &[&str] =
            if thread { &["PullRequestReviewThread"] } else { &["PullRequestReviewComment", "PullRequestReview", "IssueComment"] };
        if !kinds.contains(&node.kind.as_str()) {
            return None;
        }
        let pr = node.pull_request?;
        Some((pr.repository.name_with_owner, pr.number))
    }

    fn resolve_argv(&self, thread_id: &str, resolved: bool) -> Vec<String> {
        let query = format!("query={}", if resolved { RESOLVE_MUTATION } else { UNRESOLVE_MUTATION });
        words(&["api", "graphql", "-f", &query, "-f", &format!("id={thread_id}")])
    }

    fn read_resolve(&self, stdout: &str) -> Option<GitPrResolveReply> {
        let read: GhResolved = serde_json::from_str(stdout.trim()).ok()?;
        let data = read.data?;
        let thread = data.resolve_review_thread.or(data.unresolve_review_thread)?.thread;
        Some(GitPrResolveReply { thread_id: thread.id, resolved: thread.is_resolved })
    }

    fn react_argv(&self, subject: &str, content: ReactionContent, on: bool) -> Vec<String> {
        let query = format!("query={}", if on { REACT_MUTATION } else { UNREACT_MUTATION });
        words(&["api", "graphql", "-f", &query, "-f", &format!("id={subject}"), "-f", &format!("content={}", reaction_word(content))])
    }

    fn read_react(&self, stdout: &str) -> Option<Vec<PullRequestReaction>> {
        let read: GhReacted = serde_json::from_str(stdout.trim()).ok()?;
        let data = read.data?;
        Some(counted(&data.add_reaction.or(data.remove_reaction)?.subject.reaction_groups).unwrap_or_default())
    }

    fn is_node_id(&self, id: &str) -> bool {
        (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'='))
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
    pub(crate) const VIEW_JSON: &str = r#"{"additions":3369,"baseRefName":"main","changedFiles":95,"commits":[{"authoredDate":"2026-09-26T19:28:02Z","messageHeadline":"an older one","oid":"0000000000000000000000000000000000000001"},{"authoredDate":"2026-09-27T19:28:02Z","messageHeadline":"feat(daemon): commit, discard and save from a pane","oid":"ec5c10de663bd1860925ad42e9580bab4eb1d377"}],"deletions":289,"headRefName":"ticket/batch9-git","headRefOid":"ec5c10de663bd1860925ad42e9580bab4eb1d377","isDraft":false,"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","number":870,"reviewDecision":"CHANGES_REQUESTED","state":"OPEN","updatedAt":"2026-09-28T10:00:00Z","url":"https://github.com/Zingzy/wsp/pull/870"}"#;

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
        assert_eq!(
            GitHub.checks_argv("o/r", 12),
            ["pr", "checks", "12", "-R", "o/r", "--json", "name,bucket,link,workflow,description,startedAt,completedAt"]
        );
        assert_eq!(GitHub.behind_argv("o/r", "main", "abc123"), ["api", "repos/o/r/compare/main...abc123", "--jq", ".behind_by"]);
        // A branch name is git's to allow: a `#`, a `%` or a space in it is escaped so the path is not cut there, and a
        // slash stays the separator GitHub reads in a branch name.
        assert_eq!(GitHub.behind_argv("o/r", "release#2", "abc123")[1], "repos/o/r/compare/release%232...abc123");
        assert_eq!(GitHub.behind_argv("o/r", "50% off", "ab")[1], "repos/o/r/compare/50%25%20off...ab");
        assert_eq!(GitHub.behind_argv("o/r", "release/1.0", "ab")[1], "repos/o/r/compare/release/1.0...ab");
        assert_eq!(
            GitHub.page_argv("Zingzy/wsp", 772),
            ["api", "graphql", "-f", &format!("query={PAGE_QUERY}"), "-f", "owner=Zingzy", "-f", "name=wsp", "-F", "number=772"]
        );
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

    /// What GitHub answered for PR 772 of Zingzy/wsp on 2026-10-05 to the page's one GraphQL read, and what gh 2.97
    /// answered on 2026-10-02 for its checks.
    const PAGE_772: &str = include_str!("../../tests/gh/pr772-page.json");
    const CHECKS_772: &str = include_str!("../../tests/gh/pr772-checks.json");

    fn page_772() -> GitPrViewReply {
        GitHub.read_page(PAGE_772).unwrap()
    }

    /// A captured read with one change made to its JSON, which must have changed it.
    fn edited(read: &str, edit: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut json: serde_json::Value = serde_json::from_str(read).unwrap();
        edit(&mut json["data"]["repository"]["pullRequest"]);
        let out = json.to_string();
        assert_ne!(serde_json::from_str::<serde_json::Value>(&out).unwrap(), serde_json::from_str::<serde_json::Value>(read).unwrap());
        out
    }

    #[test]
    fn a_page_reads_when_it_opened_and_settled_and_no_body_on_it_is_cut() {
        let read = page_772();
        assert_eq!(read.title, "wsp-map#1235: a delete says gone only when the provider's reads agree");
        assert_eq!(read.author, "Zingzy");
        assert_eq!((read.created_at.as_str(), read.closed_at.as_deref()), ("2026-09-26T01:29:01Z", Some("2026-09-26T03:58:27Z")));
        // Closed by a squash landing, so nothing merged it on GitHub.
        assert_eq!((read.merged_at.as_deref(), read.merged_by.as_deref(), read.merge_commit.as_deref()), (None, None, None));
        assert!(read.labels.is_empty() && read.review_requests.is_empty() && read.latest_reviews.is_empty() && read.assignees.is_empty());
        // The first review's body is past the 4,000 characters a list keeps, and the page keeps it whole.
        assert_eq!(read.reviews[0].body.chars().count(), 7116);
        assert!(!read.reviews[0].body.ends_with('…'));
    }

    #[test]
    fn each_commit_carries_its_body_its_author_its_parents_its_lines_and_its_checks() {
        let read = page_772();
        let first = &read.commits[0];
        assert_eq!(
            (first.oid.as_str(), first.subject.as_str()),
            ("ed1c5067088b8e8cc872dc6a38b2de332ffd39ec", "fix(engine): a kill is done only when reads agree the machine is gone")
        );
        assert_eq!(first.body.chars().count(), 438);
        assert_eq!(first.author, "Zingzy");
        // A commit no check ran on rolls up to nothing.
        assert_eq!((first.parents, first.additions, first.deletions, first.check), (Some(1), Some(148), Some(35), None));
        let merge = &read.commits[1];
        assert_eq!((merge.parents, merge.additions, merge.deletions, merge.check), (Some(2), Some(786), Some(93), Some(CheckState::Pass)));
        // A commit whose email GitHub matched to no account says the name it was made under.
        let nobody = edited(PAGE_772, |pr| pr["commits"]["nodes"][0]["commit"]["author"]["user"] = serde_json::Value::Null);
        assert_eq!(GitHub.read_page(&nobody).unwrap().commits[0].author, "zingzy");
    }

    #[test]
    fn a_review_carries_the_id_its_line_comments_name() {
        let read = page_772();
        let ids: Vec<Option<u64>> = read.reviews.iter().map(|r| r.id).collect();
        assert_eq!(ids, [Some(5324159317), Some(5324405558), Some(5324405617)]);
        assert_eq!(read.review_comments[0].review_id, Some(5324159317));
        assert_eq!((read.reviews[1].state.as_str(), read.reviews[1].association.as_deref()), ("commented", Some("owner")));
    }

    #[test]
    fn a_conversation_comment_says_who_whether_a_bot_wrote_it_and_the_face_github_shows() {
        let read = page_772();
        let bot = &read.comments[0];
        assert_eq!((bot.id, bot.author.as_str(), bot.bot), (5841958969, "vercel[bot]", true));
        assert_eq!(bot.association.as_deref(), Some("none"));
        assert_eq!(bot.avatar.as_deref(), Some("https://avatars.githubusercontent.com/in/8329?v=4"));
        assert_eq!(bot.url, "https://github.com/Zingzy/wsp/pull/772#issuecomment-5841958969");
        assert_eq!(bot.at, "2026-09-26T01:29:03Z");
        let person = &read.comments[1];
        assert_eq!((person.author.as_str(), person.bot, person.association.as_deref()), ("Zingzy", false, Some("owner")));
        assert_eq!(
            person.avatar.as_deref(),
            Some("https://avatars.githubusercontent.com/u/90309290?u=e72afe1adb66db889e53c8478cbde71580ae3856&v=4")
        );
        assert_eq!(read.comments.len(), 4);
    }

    #[test]
    fn a_line_comment_carries_its_hunk_the_comment_it_answers_and_its_threads_resolution() {
        let read = page_772();
        let first = &read.review_comments[0];
        assert_eq!(
            (first.id, first.path.as_str(), first.line, first.reply_to),
            (4109844888, "packages/engine/src/golden.ts", Some(111), None)
        );
        assert_eq!(first.side.as_deref(), Some("RIGHT"));
        let hunk = first.hunk.as_deref().unwrap();
        assert!(hunk.starts_with("@@ -105"), "{hunk}");
        assert_eq!(hunk.len(), 490);
        assert_eq!((first.bot, first.resolved, first.association.as_deref()), (false, Some(false), Some("owner")));
        let reply = &read.review_comments[2];
        assert_eq!((reply.id, reply.reply_to, reply.review_id), (4110044839, Some(4109844888), Some(5324405558)));
        assert_eq!(reply.resolved, Some(false));
    }

    /// cli/cli PR 14519 as GitHub answered the page's read on 2026-10-05, whose threads are resolved but one.
    const PAGE_14519: &str = include_str!("../../tests/gh/pr14519-page.json");

    #[test]
    fn a_resolved_thread_reads_resolved_on_its_first_comment_and_every_reply() {
        let read = GitHub.read_page(PAGE_14519).unwrap();
        let resolved = |id: u64| read.review_comments.iter().find(|c| c.id == id).unwrap().resolved;
        assert_eq!((resolved(4106126529), resolved(4106458120)), (Some(true), Some(true)));
        assert_eq!((resolved(4107865905), resolved(4108367439), resolved(4110502951)), (Some(false), Some(false), Some(false)));
        let copilot = &read.review_comments[0];
        assert_eq!((copilot.author.as_str(), copilot.bot, copilot.line), ("copilot-pull-request-reviewer[bot]", true, Some(40)));
        assert_eq!(copilot.avatar.as_deref(), Some("https://avatars.githubusercontent.com/in/946600?v=4"));
        // A deleted account is nobody and no bot, and a comment GitHub gave no association for says none rather than
        // a guess.
        let gone = edited(PAGE_14519, |pr| {
            let comment = &mut pr["reviewThreads"]["nodes"][0]["comments"]["nodes"][0];
            comment["author"] = serde_json::Value::Null;
            comment["authorAssociation"] = "".into();
        });
        let read = GitHub.read_page(&gone).unwrap();
        let ghost = &read.review_comments[0];
        assert_eq!((ghost.author.as_str(), ghost.bot, ghost.avatar.as_deref(), ghost.association.as_deref()), ("", false, None, None));
    }

    /// The fields cli/cli PR 14543 answered with on 2026-10-02, cut to the ones read here.
    #[test]
    fn labels_the_reviews_asked_the_verdicts_the_assignees_and_the_merge_are_read_off_the_graphql_read() {
        let page = r#"{"data":{"repository":{"pullRequest":{"title":"chore(deps): bump the codeql-actions group with 3 updates","body":"","author":{"login":"dependabot"},"createdAt":"2026-09-28T14:06:19Z","updatedAt":"2026-09-29T10:34:00Z","closedAt":"2026-09-29T10:34:00Z","mergedAt":"2026-09-29T10:34:00Z","mergedBy":{"login":"williammartin"},"mergeCommit":{"oid":"1cd39adbf03b0afc7c4600ad829fd3f196335800"},"labels":{"nodes":[{"name":"dependencies","description":"Pull requests that update a dependency file","color":"0366d6"},{"name":"github_actions","description":"","color":"000000"}]},"reviewRequests":{"nodes":[{"requestedReviewer":{"__typename":"User","login":"BagToad"}},{"requestedReviewer":{"__typename":"Team","name":"CLI","slug":"code-reviewers","organization":{"login":"cli"}}}]},"latestReviews":{"nodes":[{"author":{"login":"williammartin"},"submittedAt":"2026-09-29T10:33:52Z","state":"APPROVED"}]},"assignees":{"nodes":[{"login":"BagToad"}]}}}}}"#;
        let read = GitHub.read_page(page).unwrap();
        assert_eq!(
            (read.merged_by.as_deref(), read.merge_commit.as_deref()),
            (Some("williammartin"), Some("1cd39adbf03b0afc7c4600ad829fd3f196335800"))
        );
        assert_eq!(read.merged_at.as_deref(), Some("2026-09-29T10:34:00Z"));
        assert_eq!(
            read.labels,
            [
                PullRequestLabel {
                    name: "dependencies".into(),
                    color: "0366d6".into(),
                    description: Some("Pull requests that update a dependency file".into())
                },
                PullRequestLabel { name: "github_actions".into(), color: "000000".into(), description: None },
            ]
        );
        // A team reads as its organization and slug, as gh spelled it.
        assert_eq!(
            read.review_requests,
            [
                PullRequestReviewRequest { name: "BagToad".into(), team: false },
                PullRequestReviewRequest { name: "cli/code-reviewers".into(), team: true }
            ]
        );
        assert_eq!(
            read.latest_reviews,
            [PullRequestVerdict { author: "williammartin".into(), state: "approved".into(), at: "2026-09-29T10:33:52Z".into() }]
        );
        assert_eq!(read.assignees, ["BagToad"]);
        // A read that holds no pull request is not a page this reads.
        assert!(GitHub.read_page(r#"{"data":{"repository":{"pullRequest":null}}}"#).is_none());
        assert!(GitHub.read_page("Not Found").is_none());
    }

    /// PR 772's threads hold their comments two and two, and the page lists them as one, in the order they were made.
    #[test]
    fn the_comments_of_every_thread_read_as_one_list_in_the_order_they_were_made() {
        let ids: Vec<u64> = page_772().review_comments.iter().map(|c| c.id).collect();
        assert_eq!(ids, [4109844888, 4109844890, 4110044839, 4110044915]);
    }

    /// A pull request past what the read holds says which parts it holds only in part: commits past the first
    /// hundred, and reviews and threads before the newest hundred.
    #[test]
    fn a_page_read_only_in_part_says_which_parts() {
        assert_eq!(page_772().cut, None);
        let past = edited(PAGE_772, |pr| {
            pr["commits"]["totalCount"] = 113.into();
            pr["reviews"]["pageInfo"]["hasPreviousPage"] = true.into();
            pr["reviewThreads"]["pageInfo"]["hasPreviousPage"] = true.into();
        });
        let read = GitHub.read_page(&past).unwrap();
        assert_eq!(read.cut, Some(PullRequestPageCut { commits: Some(true), reviews: Some(true), threads: Some(true), comments: None }));
        let threads_only = edited(PAGE_772, |pr| pr["reviewThreads"]["pageInfo"]["hasPreviousPage"] = true.into());
        let read = GitHub.read_page(&threads_only).unwrap();
        assert_eq!(read.cut, Some(PullRequestPageCut { commits: None, reviews: None, threads: Some(true), comments: None }));
    }

    #[test]
    fn each_item_carries_its_node_id_its_reactions_and_a_line_comment_its_thread() {
        let read = GitHub.read_page(PAGE_14519).unwrap();
        let first = &read.review_comments[0];
        assert_eq!((first.id, first.node_id.as_deref()), (4106126529, Some("PRRC_kwDODKw3uc70voTB")));
        assert_eq!(first.reactions, Some(vec![PullRequestReaction { content: ReactionContent::ThumbsUp, count: 1, mine: false }]));
        let reply = &read.review_comments[2];
        assert_eq!((reply.id, reply.reply_to, reply.reactions.as_ref()), (4106458120, Some(4106126529), None));
        assert_eq!(
            (first.thread_id.as_deref(), reply.thread_id.as_deref()),
            (Some("PRRT_kwDODKw3uc6mD3eD"), Some("PRRT_kwDODKw3uc6mD3eD"))
        );
        assert_eq!((first.resolved, reply.resolved), (Some(true), Some(true)));
        // A review's node id is what a reaction names.
        let review = &read.reviews[0];
        assert_eq!((review.id, review.node_id.as_deref()), (Some(5319607822), Some("PRR_kwDODKw3uc8AAAABPRLGDg")));
        assert_eq!(review.reactions, Some(vec![PullRequestReaction { content: ReactionContent::ThumbsUp, count: 1, mine: false }]));
        assert_eq!(read.cut, None);
        // Where the signed-in person left one, it reads as theirs.
        let mine = edited(PAGE_14519, |pr| {
            let comment = &mut pr["reviewThreads"]["nodes"][0]["comments"]["nodes"][0];
            assert_eq!(comment["databaseId"], 4106126529_u64);
            comment["reactionGroups"][0]["viewerHasReacted"] = true.into();
        });
        let read = GitHub.read_page(&mine).unwrap();
        assert_eq!(
            read.review_comments[0].reactions,
            Some(vec![PullRequestReaction { content: ReactionContent::ThumbsUp, count: 1, mine: true }])
        );
        assert_eq!(read.review_comments[1].reactions.as_ref().map(|r| r[0].mine), Some(false));
    }

    #[test]
    fn a_conversation_comment_carries_its_node_id_and_counts_and_older_ones_are_marked_cut() {
        let read = page_772();
        assert_eq!(read.comments[0].node_id.as_deref(), Some("IC_kwDOULIAx88AAAABXDU4OQ"));
        assert_eq!(read.comments[0].reactions, None);
        assert_eq!(read.review_comments[2].thread_id.as_deref(), Some("PRRT_kwDOULIAx86mM5yP"));
        let hearts = edited(PAGE_772, |pr| {
            for group in pr["comments"]["nodes"][0]["reactionGroups"].as_array_mut().unwrap() {
                match group["content"].as_str() {
                    Some("HEART") => {
                        group["reactors"]["totalCount"] = 2.into();
                        group["viewerHasReacted"] = true.into();
                    }
                    Some("EYES") => group["reactors"]["totalCount"] = 1.into(),
                    _ => {}
                }
            }
        });
        let read = GitHub.read_page(&hearts).unwrap();
        assert_eq!(
            read.comments[0].reactions,
            Some(vec![
                PullRequestReaction { content: ReactionContent::Heart, count: 2, mine: true },
                PullRequestReaction { content: ReactionContent::Eyes, count: 1, mine: false }
            ])
        );
        let older = edited(PAGE_772, |pr| pr["comments"]["pageInfo"]["hasPreviousPage"] = true.into());
        let read = GitHub.read_page(&older).unwrap();
        assert_eq!(read.cut, Some(PullRequestPageCut { commits: None, reviews: None, threads: None, comments: Some(true) }));
    }

    /// PR 772's comments in its conversation and on its lines as the REST API listed them on 2026-10-02, which is the
    /// shape it answers a posted reply with.
    const COMMENTS_772: &str = include_str!("../../tests/gh/pr772-comments.json");
    const LINES_772: &str = include_str!("../../tests/gh/pr772-line-comments.json");

    #[test]
    fn a_reply_posts_its_body_as_typed_on_stdin_and_reads_back_the_new_comment() {
        assert_eq!(GitHub.reply_argv("o/r", 12, None), ["api", "--method", "POST", "repos/o/r/issues/12/comments", "--input", "-"]);
        assert_eq!(
            GitHub.reply_argv("o/r", 12, Some(7)),
            ["api", "--method", "POST", "repos/o/r/pulls/12/comments/7/replies", "--input", "-"]
        );
        let body = "Fixed in 9703d1f.\n\n\"quoted\" `code` $HOME ${{x}} } mutation { deleteRepository }";
        let input: serde_json::Value = serde_json::from_str(&GitHub.reply_input(body)).unwrap();
        assert_eq!(input, serde_json::json!({ "body": body }));
        // What the REST API answers a post with is the comment as its list gives it.
        let posted: Vec<Vec<serde_json::Value>> = serde_json::from_str(COMMENTS_772).unwrap();
        let read = GitHub.read_reply(&posted[0][1].to_string(), false, None).unwrap();
        assert_eq!(read.review_comment, None);
        let comment = read.comment.unwrap();
        assert_eq!((comment.id, comment.author.as_str(), comment.association.as_deref()), (5842606909, "Zingzy", Some("owner")));
        let lines: Vec<Vec<serde_json::Value>> = serde_json::from_str(LINES_772).unwrap();
        let read = GitHub.read_reply(&lines[0][2].to_string(), true, Some("PRRT_kwDOULIAx86mM5yP")).unwrap();
        let line = read.review_comment.unwrap();
        assert_eq!((line.id, line.reply_to, line.node_id.is_some()), (4110044839, Some(4109844888), true));
        // The thread the reply was posted into rides back on it, unresolved as a reply leaves it.
        assert_eq!((line.thread_id.as_deref(), line.resolved), (Some("PRRT_kwDOULIAx86mM5yP"), Some(false)));
        assert!(GitHub.read_reply("{\"message\":\"Validation Failed\"}", true, None).is_none());
    }

    /// What GitHub answered on 2026-10-02 to the scope read for a thread, a comment on a line, a review and a comment in
    /// the conversation of Zingzy/wsp PR 772, and for an id it holds no node for.
    #[test]
    fn the_scope_read_names_the_pull_request_a_thread_or_a_reactable_sits_on_and_nothing_for_any_other_node() {
        let at = |kind: &str| {
            format!(
                r#"{{"data":{{"node":{{"__typename":"{kind}","pullRequest":{{"number":772,"repository":{{"nameWithOwner":"Zingzy/wsp"}}}}}}}}}}"#
            )
        };
        let here = Some(("Zingzy/wsp".to_owned(), 772));
        assert_eq!(GitHub.read_scope(&at("PullRequestReviewThread"), true), here);
        for kind in ["PullRequestReviewComment", "PullRequestReview", "IssueComment"] {
            assert_eq!(GitHub.read_scope(&at(kind), false), here, "{kind}");
            assert_eq!(GitHub.read_scope(&at(kind), true), None, "{kind} is no thread");
        }
        assert_eq!(GitHub.read_scope(&at("PullRequestReviewThread"), false), None);
        // A comment on an issue sits on no pull request, and an id GitHub holds nothing for names no node.
        assert_eq!(GitHub.read_scope(r#"{"data":{"node":{"__typename":"IssueComment","pullRequest":null}}}"#, false), None);
        let missing = r#"{"data":{"node":null},"errors":[{"type":"NOT_FOUND","path":["node"],"message":"Could not resolve to a node with the global id of 'I_kwDOULIAx87xxxxxx'"}]}"#;
        assert_eq!(GitHub.read_scope(missing, true), None);
        assert_eq!(GitHub.scope_argv("PRRT_x"), ["api", "graphql", "-f", &format!("query={SCOPE_QUERY}"), "-f", "id=PRRT_x"]);
    }

    /// The mutations' answers in the shape GitHub's GraphQL schema gives them.
    #[test]
    fn a_resolve_and_a_reaction_name_what_they_act_on_as_variables_and_read_back_where_it_stands() {
        let resolve = GitHub.resolve_argv("PRRT_kwDOULIAx86mM5yP", true);
        assert_eq!(resolve, ["api", "graphql", "-f", &format!("query={RESOLVE_MUTATION}"), "-f", "id=PRRT_kwDOULIAx86mM5yP"]);
        assert_eq!(GitHub.resolve_argv("PRRT_x", false)[3], format!("query={UNRESOLVE_MUTATION}"));
        let done = r#"{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_kwDOULIAx86mM5yP","isResolved":true}}}}"#;
        assert_eq!(GitHub.read_resolve(done), Some(GitPrResolveReply { thread_id: "PRRT_kwDOULIAx86mM5yP".into(), resolved: true }));
        let undone = r#"{"data":{"unresolveReviewThread":{"thread":{"id":"PRRT_x","isResolved":false}}}}"#;
        assert_eq!(GitHub.read_resolve(undone), Some(GitPrResolveReply { thread_id: "PRRT_x".into(), resolved: false }));
        assert_eq!(GitHub.read_resolve(r#"{"data":null,"errors":[{"message":"Could not resolve to a node"}]}"#), None);
        assert_eq!(
            GitHub.react_argv("IC_kwDOULIAx88AAAABXDU4OQ", ReactionContent::ThumbsUp, true),
            ["api", "graphql", "-f", &format!("query={REACT_MUTATION}"), "-f", "id=IC_kwDOULIAx88AAAABXDU4OQ", "-f", "content=THUMBS_UP"]
        );
        assert_eq!(GitHub.react_argv("IC_x", ReactionContent::Eyes, false)[3], format!("query={UNREACT_MUTATION}"));
        let reacted = r#"{"data":{"addReaction":{"subject":{"reactionGroups":[{"content":"THUMBS_UP","viewerHasReacted":true,"reactors":{"totalCount":2}},{"content":"THUMBS_DOWN","viewerHasReacted":false,"reactors":{"totalCount":0}},{"content":"HEART","viewerHasReacted":false,"reactors":{"totalCount":1}}]}}}}"#;
        assert_eq!(
            GitHub.read_react(reacted),
            Some(vec![
                PullRequestReaction { content: ReactionContent::ThumbsUp, count: 2, mine: true },
                PullRequestReaction { content: ReactionContent::Heart, count: 1, mine: false }
            ])
        );
        let none_left = r#"{"data":{"removeReaction":{"subject":{"reactionGroups":[{"content":"EYES","viewerHasReacted":false,"reactors":{"totalCount":0}}]}}}}"#;
        assert_eq!(GitHub.read_react(none_left), Some(vec![]));
        for id in ["PRRT_kwDOULIAx86mM5yP", "IC_kwDOULIAx88AAAABXDU4OQ", "MDQ6VXNlcjkwMzA5Mjkw=="] {
            assert!(GitHub.is_node_id(id), "{id}");
        }
        for id in ["", "PRRT_x\") { deleteRepository", "a b", "x\n", &"a".repeat(129)] {
            assert!(!GitHub.is_node_id(id), "{id}");
        }
    }

    #[test]
    fn a_check_says_when_it_started_and_finished_and_one_not_started_says_neither() {
        let checks = GitHub.read_checks(CHECKS_772).unwrap();
        assert_eq!(checks[0].name, "Linux daemon aarch64-unknown-linux-musl");
        assert_eq!(
            (checks[0].started_at.as_deref(), checks[0].completed_at.as_deref()),
            (Some("2026-09-26T03:05:23Z"), Some("2026-09-26T03:06:59Z"))
        );
        // gh prints Go's zero time for a check that has not started or not finished.
        let queued = r#"[{"bucket":"pending","name":"e2e","link":"","workflow":"ci","description":"","startedAt":"0001-01-01T00:00:00Z","completedAt":"0001-01-01T00:00:00Z"}]"#;
        let queued = GitHub.read_checks(queued).unwrap();
        assert_eq!((queued[0].started_at.as_deref(), queued[0].completed_at.as_deref()), (None, None));
    }

    #[test]
    fn a_merge_armed_to_land_names_its_method_and_who_armed_it() {
        let armed = r#"{"number":5,"url":"u","state":"OPEN","autoMergeRequest":{"authorEmail":null,"commitBody":null,"commitHeadline":null,"mergeMethod":"SQUASH","enabledAt":"2026-09-29T10:00:00Z","enabledBy":{"login":"Zingzy"}}}"#;
        assert_eq!(
            GitHub.read(armed).unwrap().auto_merge,
            Some(PullRequestAutoMerge { method: MergeMethod::Squash, by: Some("Zingzy".into()) })
        );
        assert_eq!(GitHub.read(r#"{"number":5,"url":"u","state":"OPEN","autoMergeRequest":null}"#).unwrap().auto_merge, None);
        assert!(FIELDS.ends_with(",autoMergeRequest"));
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
