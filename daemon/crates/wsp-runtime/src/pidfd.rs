// SPDX-License-Identifier: AGPL-3.0-only
//! A process held by a descriptor rather than by its number: the kernel never hands a pidfd's process to anybody
//! else, so whatever reads or signals through one reaches the process it was opened on, or nothing once that one
//! has gone. `pidfd_open` wants Linux 5.3 and `pidfd_send_signal` 5.1.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

/// A descriptor for the process the pid names now; an error where it is gone or the kernel has no pidfds.
pub fn open(pid: i32) -> io::Result<OwnedFd> {
    // SAFETY: pidfd_open takes two plain integers and answers a descriptor or -1.
    let opened = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if opened < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the kernel answered this descriptor just now and nothing else holds it.
    Ok(unsafe { OwnedFd::from_raw_fd(opened as RawFd) })
}

/// Sends the signal to the process the descriptor holds; ESRCH once that process has gone, whoever has its number.
pub fn send_signal(fd: &OwnedFd, signal: i32) -> io::Result<()> {
    // SAFETY: the descriptor is a live pidfd this caller owns, and a null siginfo with no flags is the plain kill.
    let sent = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd.as_raw_fd(), signal, std::ptr::null::<libc::siginfo_t>(), 0) };
    if sent < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
