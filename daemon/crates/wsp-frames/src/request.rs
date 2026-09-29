// SPDX-License-Identifier: AGPL-3.0-only
use std::collections::BTreeMap;
use std::num::{NonZeroU16, NonZeroU32};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::validate::{bounded, bounded_opt, capped_list, exec_timeout, sha256_hex, upload_word};
use crate::{FsReadEncoding, FsSearchMode, GitDiffScope, GuestKind, MergeMethod, ProcSignal, RequestId};

/// One request on an authed socket: the id the reply echoes and the op with its parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DaemonRequest {
    pub id: RequestId,
    #[serde(flatten)]
    pub op: DaemonOp,
}

/// Every op the protocol's DaemonRequest names, keyed on `op` as the zod discriminated union is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "op")]
pub enum DaemonOp {
    #[serde(rename = "pty.create", rename_all = "camelCase")]
    PtyCreate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cols: Option<NonZeroU16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        rows: Option<NonZeroU16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        shell: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        env: Option<BTreeMap<String, String>>,
        /// The workspace this pty is for, on a daemon that runs workspaces: the shell opens inside that
        /// workspace's namespaces, in the folder the frame names, which is absolute and is asked for, since this
        /// daemon has no working directory inside a workspace. Without one the shell is the daemon's own
        /// computer's, which is every machine wsp forked. The pty is held beside the daemon's own either way, and
        /// every other pty op names the same workspace to reach it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    #[serde(rename = "pty.attach", rename_all = "camelCase")]
    PtyAttach {
        pty_id: String,
        /// The workspace whose pty this is, as on pty.create above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// This socket's listeners off that pty: the mirror of pty.attach, so a pane that closed stops the bytes of
    /// its own pty on a socket many panes share.
    #[serde(rename = "pty.detach", rename_all = "camelCase")]
    PtyDetach {
        pty_id: String,
        /// The workspace whose pty this is, as on pty.create above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    #[serde(rename = "pty.write", rename_all = "camelCase")]
    PtyWrite {
        pty_id: String,
        data: String,
        /// The workspace whose pty this is, as on pty.create above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// A size of zero is refused here as node-pty refuses it; the protocol's number says only "number".
    #[serde(rename = "pty.resize", rename_all = "camelCase")]
    PtyResize {
        pty_id: String,
        cols: NonZeroU16,
        rows: NonZeroU16,
        /// The workspace whose pty this is, as on pty.create above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    #[serde(rename = "pty.kill", rename_all = "camelCase")]
    PtyKill {
        pty_id: String,
        /// The workspace whose pty this is, as on pty.create above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    #[serde(rename = "pty.list", rename_all = "camelCase")]
    PtyList {
        /// The workspace whose ptys are listed, as on pty.create above: with one, that workspace's alone, and
        /// without one, this daemon's own alone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    #[serde(rename = "ports.watch")]
    PortsWatch,
    #[serde(rename = "manifest.get")]
    ManifestGet,
    #[serde(rename = "manifest.record", rename_all = "camelCase")]
    ManifestRecord {
        cmd: String,
        cwd: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        port: Option<u16>,
    },
    #[serde(rename = "manifest.restartScript")]
    ManifestRestartScript,
    #[serde(rename = "inbox.watch")]
    InboxWatch,
    #[serde(rename = "inbox.rescan")]
    InboxRescan,
    #[serde(rename = "sys.watch")]
    SysWatch,
    #[serde(rename = "proc.watch")]
    ProcWatch,
    #[serde(rename = "proc.unwatch")]
    ProcUnwatch,
    #[serde(rename = "proc.inspect")]
    ProcInspect { pid: NonZeroU32 },
    #[serde(rename = "proc.kill")]
    ProcKill { pid: NonZeroU32, signal: ProcSignal },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "fs.list", rename_all = "camelCase")]
    FsList {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        gitignore: Option<bool>,
        /// The workspace this frame is for, on a daemon that runs workspaces: the path then names the folder as
        /// that workspace sees it, and the operation is answered inside it. Without one the path is resolved under
        /// this daemon's own roots.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Every file of the checkout under the folder that git would show, tracked or untracked and never ignored,
    /// each relative to that folder: what the composer's file mention picks from.
    #[serde(rename = "fs.files", rename_all = "camelCase")]
    FsFiles {
        cwd: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    #[serde(rename = "fs.read", rename_all = "camelCase")]
    FsRead {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        encoding: Option<FsReadEncoding>,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Replaces an existing regular file's contents whole, keeping its mode and owner: a pane's save.
    #[serde(rename = "fs.write", rename_all = "camelCase")]
    FsWrite {
        path: String,
        contents: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Every file under the folder whose path holds the query's letters in order (files), or every line of a text
    /// file there that holds the query (text), walked with the folder's ignore rules and hidden names left out.
    #[serde(rename = "fs.search", rename_all = "camelCase")]
    FsSearch {
        path: String,
        query: String,
        mode: FsSearchMode,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    #[serde(rename = "git.status", rename_all = "camelCase")]
    GitStatus {
        cwd: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    #[serde(rename = "git.diff", rename_all = "camelCase")]
    GitDiff {
        cwd: String,
        scope: GitDiffScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        path: Option<String>,
        /// Only these files, named from the checkout's top as the reply names them.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        paths: Option<Vec<String>>,
        /// Each file's patch holds the whole file in one hunk, which is what an editor over the new side needs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        whole: Option<bool>,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Pushes the branch this checkout is on to its remote, refusing the base branch itself: work leaves a
    /// workspace through git, and the branch is the agent's own to make.
    #[serde(rename = "git.push", rename_all = "camelCase")]
    GitPush {
        cwd: String,
        /// The branch the work started from; without one the checkout's own default branch, which is what a
        /// project recorded without a base was cloned at.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        base: Option<String>,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Puts one changed file back as HEAD has it, or removes it where HEAD has none: the one file named, never the
    /// rest of the checkout.
    #[serde(rename = "git.discard", rename_all = "camelCase")]
    GitDiscard {
        cwd: String,
        /// The file as git.status names it, from the checkout's top.
        path: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Commits the named files and no others with the message given, hooks and all.
    #[serde(rename = "git.commit", rename_all = "camelCase")]
    GitCommit {
        cwd: String,
        message: String,
        /// The files as git.status names them, from the checkout's top.
        paths: Vec<String>,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Opens the branch's pull request against the base through the git host's own signed-in command line, or
    /// answers with the one that is already open.
    #[serde(rename = "git.pr", rename_all = "camelCase")]
    GitPr {
        cwd: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        base: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        body: Option<String>,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// A pull request as the git host has it, by branch or by number, read through the host's signed-in command line
    /// with the repository named off the remote given and never off the checkout: the folder is where that line runs,
    /// and no git runs there.
    #[serde(rename = "git.prRead", rename_all = "camelCase")]
    GitPrRead {
        cwd: String,
        /// The project's remote as the host recorded it, which names the repository.
        remote: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        number: Option<u64>,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// One pull request's page: title, body, commits, reviews, the conversation, the comments on lines and the files,
    /// through that same command line.
    #[serde(rename = "git.prView", rename_all = "camelCase")]
    GitPrView {
        cwd: String,
        remote: String,
        number: u64,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// The failed steps of one job of one run, the last CHECK_LOG_LINES lines of them.
    #[serde(rename = "git.runLog", rename_all = "camelCase")]
    GitRunLog {
        cwd: String,
        remote: String,
        run_id: u64,
        job_id: u64,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Merges a pull request by the method named, or arms it to merge once its checks pass, and only while its head is
    /// still the commit named.
    #[serde(rename = "git.prMerge", rename_all = "camelCase")]
    GitPrMerge {
        cwd: String,
        remote: String,
        number: u64,
        method: MergeMethod,
        auto: bool,
        head_oid: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// How the repository lets a pull request land: its merge methods, the default one and whether it merges by itself.
    #[serde(rename = "git.repoRead", rename_all = "camelCase")]
    GitRepoRead {
        cwd: String,
        remote: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Merges the base's latest commits from the remote into the branch the checkout is on. A checkout with changes
    /// no commit holds is refused first; a merge that conflicts is taken back at once and answered with the files.
    #[serde(rename = "git.update", rename_all = "camelCase")]
    GitUpdate {
        cwd: String,
        /// The branch the work started from; without one the checkout's own default branch, as on git.push.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        base: Option<String>,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// The repository's open pull requests and issues, read through that same command line.
    #[serde(rename = "git.prList", rename_all = "camelCase")]
    GitPrList {
        cwd: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Records the checkout's whole working tree, untracked files in and ignored ones out, as a commit outside
    /// every branch, under a ref this daemon names from the checkout's folder, the thread and the turn. HEAD, the
    /// index and the branch never move and no hook runs.
    #[serde(rename = "git.checkpoint", rename_all = "camelCase")]
    GitCheckpoint {
        cwd: String,
        thread: String,
        turn: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// Puts the working tree back to a checkpoint this checkout holds, first recording the tree as it stands under
    /// a checkpoint of its own, so the restore can itself be undone. The index, HEAD and the branch never move.
    #[serde(rename = "git.restore", rename_all = "camelCase")]
    GitRestore {
        cwd: String,
        /// The checkpoint's ref, as a git.checkpoint answer named it.
        checkpoint: String,
        /// The workspace this frame is for, as on fs.list above.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        machine_id: Option<String>,
    },
    /// One level of folders under the home of the login this daemon runs as and under each project folder the
    /// host names, for the folder picker of a computer somebody owns: folders only, no file read.
    #[serde(rename = "fs.folders", rename_all = "camelCase")]
    FsFolders {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        dir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        hidden: Option<bool>,
        /// Every repo under the roots instead of one level.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        repos: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        projects: Option<Vec<String>>,
    },
    #[serde(rename = "tunnel.open", rename_all = "camelCase")]
    TunnelOpen { tunnel_id: String, port: NonZeroU16 },
    #[serde(rename = "tunnel.write", rename_all = "camelCase")]
    TunnelWrite { tunnel_id: String, data: String },
    #[serde(rename = "tunnel.close", rename_all = "camelCase")]
    TunnelClose { tunnel_id: String },
    #[serde(rename = "exec", rename_all = "camelCase")]
    Exec {
        #[serde(deserialize_with = "bounded::<_, 0, { crate::numbers::EXEC_BODY_MAX }>")]
        cmd: String,
        #[serde(default, deserialize_with = "exec_timeout", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        timeout_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        stdin: Option<String>,
    },
    #[serde(rename = "place.leave")]
    PlaceLeave,
    /// A process inside this machine opens its session; the token is the thread's, read by the host alone.
    #[serde(rename = "guest.open", rename_all = "camelCase")]
    GuestOpen {
        kind: GuestKind,
        #[serde(deserialize_with = "bounded::<_, 0, { crate::numbers::GUEST_TOKEN_MAX }>")]
        token: String,
        #[serde(
            default,
            deserialize_with = "bounded_opt::<_, { crate::numbers::GUEST_TOKEN_MAX }>",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        turn_token: Option<String>,
        #[serde(deserialize_with = "capped_list::<_, { crate::numbers::GUEST_ARGV_MAX }>")]
        argv: Vec<String>,
        #[serde(deserialize_with = "bounded::<_, 0, { crate::numbers::GUEST_CWD_MAX }>")]
        cwd: String,
    },
    #[serde(rename = "guest.send")]
    GuestSend {
        #[ts(type = "unknown")]
        message: serde_json::Value,
    },
    #[serde(rename = "guest.watch")]
    GuestWatch,
    #[serde(rename = "guest.reply")]
    GuestReply {
        session: String,
        #[ts(type = "unknown")]
        message: serde_json::Value,
    },
    #[serde(rename = "guest.close")]
    GuestClose {
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<String>,
    },
    /// The daemon this host deploys, in parts under one upload id, and the restart the last part ends in. The other
    /// link op: a binary travels as bytes and never as a command line.
    #[serde(rename = "place.update", rename_all = "camelCase")]
    PlaceUpdate {
        #[serde(deserialize_with = "upload_word")]
        upload_id: String,
        seq: u64,
        last: bool,
        data: String,
        #[serde(deserialize_with = "sha256_hex")]
        sha256: String,
    },
}

/// The op names above, in the protocol's order; the daemon's switch reads this to tell an op it knows from one it
/// does not.
pub const DAEMON_OPS: [&str; 51] = [
    "pty.create",
    "pty.attach",
    "pty.detach",
    "pty.write",
    "pty.resize",
    "pty.kill",
    "pty.list",
    "ports.watch",
    "manifest.get",
    "manifest.record",
    "manifest.restartScript",
    "inbox.watch",
    "inbox.rescan",
    "sys.watch",
    "proc.watch",
    "proc.unwatch",
    "proc.inspect",
    "proc.kill",
    "ping",
    "fs.list",
    "fs.files",
    "fs.read",
    "fs.search",
    "git.status",
    "git.diff",
    "git.push",
    "git.pr",
    "git.prList",
    "git.checkpoint",
    "git.restore",
    "fs.folders",
    "tunnel.open",
    "tunnel.write",
    "tunnel.close",
    "exec",
    "place.leave",
    "guest.open",
    "guest.send",
    "guest.watch",
    "guest.reply",
    "guest.close",
    "place.update",
    "git.discard",
    "git.commit",
    "fs.write",
    "git.prRead",
    "git.prView",
    "git.runLog",
    "git.prMerge",
    "git.repoRead",
    "git.update",
];

/// The five of those that belong to the road a client of this machine dials in on: a guest process's two and the
/// host's three on the socket it holds. A daemon that dialled outward to its host serves none of them.
pub const GUEST_OPS: [&str; 5] = ["guest.open", "guest.send", "guest.watch", "guest.reply", "guest.close"];
