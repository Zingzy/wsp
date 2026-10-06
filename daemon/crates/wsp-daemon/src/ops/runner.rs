// SPDX-License-Identifier: AGPL-3.0-only

use std::path::Path;

use crate::git;
use crate::paths::OpError;

/// Which way an op runs a program, and so which machine it is answered for: this computer, or one workspace this
/// computer holds. One enum rather than a generic on every arm, and one module behind each way.
pub(super) enum Runner {
    Here(git::here::Here),
    #[cfg(target_os = "linux")]
    Inside(git::inside::Inside),
}

impl git::Runs for Runner {
    async fn run(
        &self,
        cwd: &Path,
        program: &str,
        args: &[&str],
        input: Option<&[u8]>,
        max_bytes: Option<usize>,
    ) -> Result<git::GitResult, OpError> {
        match self {
            Runner::Here(here) => here.run(cwd, program, args, input, max_bytes).await,
            #[cfg(target_os = "linux")]
            Runner::Inside(inside) => inside.run(cwd, program, args, input, max_bytes).await,
        }
    }

    async fn on_path(&self, program: &str) -> Result<bool, OpError> {
        match self {
            Runner::Here(here) => here.on_path(program).await,
            #[cfg(target_os = "linux")]
            Runner::Inside(inside) => inside.on_path(program).await,
        }
    }

    fn on_this_side(&self, folder: &Path) -> Option<git::OnThisSide> {
        match self {
            Runner::Here(here) => here.on_this_side(folder),
            #[cfg(target_os = "linux")]
            Runner::Inside(inside) => inside.on_this_side(folder),
        }
    }
}
