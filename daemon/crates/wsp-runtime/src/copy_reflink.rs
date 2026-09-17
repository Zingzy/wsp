// SPDX-License-Identifier: AGPL-3.0-only
//! The copy a disk that shares blocks makes: every file cloned with FICLONE, which writes metadata and no bytes,
//! so a checkout of a gigabyte costs its directory entries and nothing else until one side is written to. The
//! two trees are separate from the moment the clone is taken: a write on either copies the blocks it touches and
//! leaves the other as it was, which is what lets a box fetch a checkout while the workspaces already made from
//! it keep the tree they booted on.

use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;

use wsp_frames::CopyWord;

use crate::copy::{copy_tree, remove_tree, Copier};

// FICLONE, _IOW(0x94, 9, int): the source's fd as the argument, the target's as the file the ioctl is on. The
// number is built by the kernel's own rule rather than written down, so it is right on every architecture.
nix::ioctl_write_int_bad!(ficlone, nix::request_code_write!(0x94, 9, std::mem::size_of::<nix::libc::c_int>()));

pub struct Reflink;

impl Copier for Reflink {
    fn word(&self) -> CopyWord {
        CopyWord::Reflink
    }

    fn copy(&self, from: &Path, to: &Path) -> io::Result<()> {
        copy_tree(from, to, clone_file)
    }

    fn remove(&self, to: &Path) -> io::Result<()> {
        remove_tree(to)
    }
}

/// One file cloned into a target that does not exist yet: the kernel shares the source's blocks with it, and the
/// walk gives it its mode, owner, times and attributes after. A kernel or a disk that refuses the clone refuses
/// it here, which is what the picker's probe reads before a copy is ever started.
pub fn clone_file(source: &Path, target: &Path) -> io::Result<()> {
    let read = File::open(source)?;
    let write = File::create_new(target)?;
    // SAFETY: both descriptors are open for the whole call, and FICLONE reads an int argument, which is what the
    // macro passes.
    unsafe { ficlone(write.as_raw_fd(), read.as_raw_fd()) }
        .map(|_| ())
        .map_err(|e| io::Error::new(io::Error::from(e).kind(), format!("{}: {e}", target.display())))
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_clone_number_is_the_kernels_own_for_this_architecture() {
        // The one number written down anywhere, and only here, against the kernel's rule as x86_64 and aarch64
        // both encode it: _IOW(0x94, 9, int).
        #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
        assert_eq!(nix::request_code_write!(0x94, 9, std::mem::size_of::<nix::libc::c_int>()) as u64, 0x4004_9409);
    }
}
