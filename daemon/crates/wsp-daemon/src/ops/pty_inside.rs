// SPDX-License-Identifier: AGPL-3.0-only
//! A pty inside one workspace this computer runs, as pty.create asks for it.

use std::collections::BTreeMap;
use std::num::NonZeroU16;
use std::sync::Arc;

#[cfg(not(target_os = "linux"))]
use wsp_frames::Empty;
#[cfg(target_os = "linux")]
use wsp_frames::PtyCreateReply;
use wsp_frames::RequestId;

#[cfg(target_os = "linux")]
use super::{answer, from_runtime, workspaces_of};
#[cfg(not(target_os = "linux"))]
use super::{answer, no_such_workspace};
#[cfg(target_os = "linux")]
use crate::pty::pump;
use crate::Ctx;

/// What a frame asks of a pty inside a workspace: its size, a shell it names, the folder, a reply's command, the
/// program it runs as argv instead, and what its environment carries.
pub(super) struct InsideAsk {
    pub(super) cols: Option<NonZeroU16>,
    pub(super) rows: Option<NonZeroU16>,
    pub(super) shell: Option<String>,
    pub(super) cwd: String,
    pub(super) run: Option<String>,
    pub(super) args: Option<Vec<String>>,
    pub(super) env: Option<BTreeMap<String, String>>,
}

/// A pty inside one workspace this computer runs: the shell opens in the folder the frame names, which is
/// absolute and is asked for, since this daemon has no working directory inside a workspace and a pty without one
/// would open a shell in the computer's own home, which every workspace has bound in. The pty is held beside this
/// daemon's own and every op on it names the same workspace.
#[cfg(target_os = "linux")]
pub(super) async fn pty_inside(ctx: &Arc<Ctx>, id: Option<RequestId>, machine: &str, ask: InsideAsk) -> String {
    let InsideAsk { cols, rows, shell, cwd, run, args, env } = ask;
    let opened = async {
        let ops = workspaces_of(ctx, machine)?;
        let (cols, rows) = (cols.map_or(80, NonZeroU16::get), rows.map_or(24, NonZeroU16::get));
        let asked = wsp_runtime::runtime::PtyAsk { shell: shell.as_deref(), run: run.as_deref(), args: args.as_deref(), env: env.as_ref() };
        let running = ops.pty_in(machine, cols, rows, &cwd, asked).await.map_err(from_runtime)?;
        let spawned = ctx.ptys.lock().unwrap_or_else(|e| e.into_inner()).take_inside(machine, cols, rows, running, run.is_some());
        let reply = PtyCreateReply { pty_id: spawned.id.clone(), pid: spawned.pid, argv: args.is_some() };
        tokio::spawn(pump(Arc::clone(ctx), spawned));
        Ok(reply)
    };
    answer(id, opened.await)
}

/// And on a computer whose daemon runs no workspace at all, which is every machine this daemon is inside: the
/// missing refusal, the same one a workspace that is gone answers.
#[cfg(not(target_os = "linux"))]
pub(super) async fn pty_inside(_ctx: &Arc<Ctx>, id: Option<RequestId>, machine: &str, _ask: InsideAsk) -> String {
    answer::<Empty>(id, Err(no_such_workspace(machine)))
}
