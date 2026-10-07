// SPDX-License-Identifier: AGPL-3.0-only
//! The filesystem under a folder in bytes: what a computer's own sample reads under its root and what a workspace's
//! reading reads under its upper, which is the disk that workspace writes to.

use std::path::Path;

use wsp_frames::Usage;

/// The filesystem under a folder as statfs reads it, in bytes.
pub fn disk_under(path: &Path) -> Result<Usage, String> {
    let fs = nix::sys::statfs::statfs(path).map_err(|e| format!("statfs {}: {e}", path.display()))?;
    let bsize = u64::try_from(fs.block_size()).unwrap_or(0);
    Ok(Usage { used: fs.blocks().saturating_sub(fs.blocks_free()) * bsize, total: fs.blocks() * bsize })
}
