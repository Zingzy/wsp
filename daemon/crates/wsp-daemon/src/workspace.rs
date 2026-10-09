// SPDX-License-Identifier: AGPL-3.0-only
//! The workspace a frame names, found on the daemon of the computer holding it.

use wsp_frames::DaemonErrorCode;

use crate::paths::OpError;
#[cfg(target_os = "linux")]
use crate::Ctx;

/// The workspace a frame names, on the daemon of the computer holding it: a workspace on a computer somebody owns
/// runs no daemon of its own, so this daemon answers for it. A daemon that runs no workspace, and one that runs
/// none by this name, answer the same missing refusal every other op answers for a machine it does not know.
#[cfg(target_os = "linux")]
pub(crate) fn workspaces_of(ctx: &Ctx, machine: &str) -> Result<std::sync::Arc<wsp_runtime::ops::Ops>, OpError> {
    match &ctx.runtime {
        Some(ops) => Ok(std::sync::Arc::clone(ops)),
        None => Err(no_such_workspace(machine)),
    }
}

/// The refusal for a workspace this daemon does not run, in the runtime's own words and with its own code, so the
/// host reads one sentence whether the workspace is gone or the computer runs none at all.
pub(crate) fn no_such_workspace(machine: &str) -> OpError {
    OpError::coded(DaemonErrorCode::NotFound, wsp_runtime::no_such_workspace(machine))
}
