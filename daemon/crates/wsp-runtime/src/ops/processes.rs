// SPDX-License-Identifier: AGPL-3.0-only
//! Where a running workspace's processes are, for the daemon that reads, inspects and signals them on its behalf.

use std::path::PathBuf;

use super::{OpError, Ops};

impl Ops {
    /// The cgroup a running workspace's processes live in, under which a server of its own is given one.
    pub fn cgroup_of_running(&self, id: &str) -> Result<PathBuf, OpError> {
        let record = self.running(id)?;
        Ok(self.layout.cgroup_dir(&record.id))
    }

    /// A running workspace's first process, in this computer's numbering: what a signal from its own Processes pane
    /// must never reach, since the workspace goes with it.
    pub fn init_of_running(&self, id: &str) -> Result<u32, OpError> {
        let record = self.running(id)?;
        u32::try_from(record.init.pid).map_err(|_| OpError::plain(format!("{id} holds no init")))
    }
}
