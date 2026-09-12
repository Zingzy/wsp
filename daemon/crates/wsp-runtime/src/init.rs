// SPDX-License-Identifier: AGPL-3.0-only
//! The workspace's first process: this binary, bound into the rootfs, runs the boot command and reaps whatever a
//! turn leaves behind, as Docker's init does. Without it every process an exec backgrounded and lost would sit as
//! a zombie under a `sleep` that never waits, each holding a pid against the workspace's cap. Signals sent to it
//! go to the child; the child's exit is its own.

use std::process::Command;

use nix::sys::signal::{kill, sigprocmask, SigSet, SigmaskHow, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;

/// The signals forwarded to the child. Blocked rather than handled: a pid 1 whose disposition is the default has
/// the kernel drop a signal, and a blocked one is queued for the wait below instead.
const FORWARDED: [Signal; 6] = [Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP, Signal::SIGQUIT, Signal::SIGUSR1, Signal::SIGUSR2];

/// Runs `argv` as the one child and answers its exit code; 127 when it could not be started.
pub fn run(argv: &[String]) -> i32 {
    let Some((program, args)) = argv.split_first() else {
        eprintln!("wsp-init: no command to run");
        return 127;
    };
    let mut set = SigSet::empty();
    set.add(Signal::SIGCHLD);
    for signal in FORWARDED {
        set.add(signal);
    }
    if let Err(e) = sigprocmask(SigmaskHow::SIG_BLOCK, Some(&set), None) {
        eprintln!("wsp-init: blocking signals: {e}");
        return 127;
    }
    // The child starts with an empty mask: the standard library resets it before the exec.
    let child = match Command::new(program).args(args).spawn() {
        Ok(child) => Pid::from_raw(child.id() as i32),
        Err(e) => {
            eprintln!("wsp-init: {program}: {e}");
            return 127;
        }
    };
    loop {
        let signal = match set.wait() {
            Ok(signal) => signal,
            Err(nix::Error::EINTR) => continue,
            Err(e) => {
                eprintln!("wsp-init: waiting for a signal: {e}");
                return 127;
            }
        };
        if signal != Signal::SIGCHLD {
            let _ = kill(child, signal);
            continue;
        }
        if let Some(code) = reap(child) {
            return code;
        }
    }
}

/// Reaps every child that has exited; the code of the one that matters, once it is among them.
fn reap(child: Pid) -> Option<i32> {
    loop {
        match waitpid(None, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(pid, code)) if pid == child => return Some(code),
            Ok(WaitStatus::Signaled(pid, signal, _)) if pid == child => return Some(128 + signal as i32),
            Ok(WaitStatus::StillAlive) | Err(_) => return None,
            Ok(_) => continue,
        }
    }
}
