// SPDX-License-Identifier: AGPL-3.0-only
//! The process ops: the machine's own processes, or one workspace's alone where the frame names it.

use std::path::Path;
use std::sync::Arc;

use wsp_frames::{DaemonOp, Empty, RequestId};

use super::{answer, ok, pid_in_range, Conn, Detach};
use crate::paths::OpError;
use crate::proc::{kill_process, kill_within, PidScope, ProtectedPids};
use crate::Ctx;

/// Answers one of the four process ops.
pub(super) async fn serve(conn: &Arc<Conn>, ctx: &Arc<Ctx>, id: Option<RequestId>, op: DaemonOp) -> String {
    match op {
        DaemonOp::ProcWatch { machine_id } => {
            let watched = async {
                let sampler = ctx.proc_sampler(machine_id.as_deref())?;
                sampler.probe().await?;
                let key = ctx.next_key();
                conn.while_open(|| {
                    let mut watch = conn.proc_watch.lock().unwrap_or_else(|e| e.into_inner());
                    // A socket already watching that watches again missed a frame: its next one is whole. One whose
                    // sampler left with a workspace that stopped takes the fresh one in its place.
                    if let Some((held, old)) = watch.get(&machine_id) {
                        if Arc::ptr_eq(old, &sampler) {
                            sampler.resend(*held);
                            return None;
                        }
                        old.unsubscribe(*held);
                    }
                    sampler.subscribe(key, conn.out.clone());
                    watch.insert(machine_id.clone(), (key, Arc::clone(&sampler)));
                    Some(Box::new(move || sampler.unsubscribe(key)) as Detach)
                });
                Ok(Empty {})
            };
            answer(id, watched.await)
        }
        DaemonOp::ProcUnwatch { machine_id } => {
            let watch = conn.proc_watch.lock().unwrap_or_else(|e| e.into_inner()).remove(&machine_id);
            if let Some((key, sampler)) = watch {
                sampler.unsubscribe(key);
            }
            ok(id)
        }
        DaemonOp::ProcInspect { pid, machine_id } => {
            let inspected = async { ctx.proc_sampler(machine_id.as_deref())?.inspect(pid_in_range(pid)?).await };
            answer(id, inspected.await)
        }
        DaemonOp::ProcKill { pid, signal, machine_id } => {
            let protected = ProtectedPids { this: std::process::id(), parent: std::os::unix::process::parent_id(), init: None };
            let killed = pid_in_range(pid).and_then(|pid| match machine_id.as_deref() {
                None => kill_process(pid, signal, protected),
                Some(machine) => {
                    let (scope, init) = workspace_pids(ctx, machine)?;
                    kill_within(pid, signal, ProtectedPids { init: Some(init), ..protected }, &scope)
                }
            });
            answer(id, killed.map(|()| Empty {}))
        }
        _ => unreachable!("only the process ops are served here"),
    }
}

/// The pids under one running workspace's cgroup, its own and its containers', read again at every ask.
#[cfg(target_os = "linux")]
pub(crate) fn pid_scope(ctx: &Ctx, machine: &str) -> Result<PidScope, OpError> {
    let ops = super::workspaces_of(ctx, machine)?;
    ops.cgroup_of_running(machine).map_err(super::from_runtime)?;
    let machine = machine.to_owned();
    Ok(Arc::new(move || cgroup_pids(&ops.cgroup_of_running(&machine).map_err(super::from_runtime)?)))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn pid_scope(_ctx: &Ctx, machine: &str) -> Result<PidScope, OpError> {
    Err(super::no_such_workspace(machine))
}

/// A running workspace's pids and its init, which a kill from its pane must not reach.
#[cfg(target_os = "linux")]
fn workspace_pids(ctx: &Ctx, machine: &str) -> Result<(PidScope, u32), OpError> {
    let scope = pid_scope(ctx, machine)?;
    Ok((scope, super::workspaces_of(ctx, machine)?.init_of_running(machine).map_err(super::from_runtime)?))
}

#[cfg(not(target_os = "linux"))]
fn workspace_pids(_ctx: &Ctx, machine: &str) -> Result<(PidScope, u32), OpError> {
    Err(super::no_such_workspace(machine))
}

#[cfg(target_os = "linux")]
pub(crate) fn cgroup_pids(cgroup: &Path) -> Result<std::collections::HashSet<u32>, OpError> {
    let pids = wsp_runtime::cgroup::pids_under(cgroup).map_err(|e| OpError::plain(format!("{}: {e}", cgroup.display())))?;
    Ok(pids.into_iter().filter_map(|pid| u32::try_from(pid).ok()).collect())
}
