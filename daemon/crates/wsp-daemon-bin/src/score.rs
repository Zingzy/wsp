// SPDX-License-Identifier: AGPL-3.0-only
//! The daemon is last for the kernel's memory killer and ahead of every default-priority process, written on its
//! own pid at start so every road that starts it gives them; a start that may not write one says so and runs on.

use wsp_frames::{numbers, words};

pub(crate) fn apply() {
    if let Err(e) = std::fs::write("/proc/self/oom_score_adj", numbers::DAEMON_OOM_SCORE_ADJ.to_string()) {
        eprintln!("{}", words::oom_not_set(&e.to_string()));
    }
    // SAFETY: setpriority takes three plain integers and touches no memory of ours.
    let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS as _, 0, numbers::DAEMON_NICE) };
    if rc != 0 {
        eprintln!("{}", words::priority_not_set(&std::io::Error::last_os_error().to_string()));
    }
}
