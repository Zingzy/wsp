// SPDX-License-Identifier: AGPL-3.0-only
//! The wsp command on the computer the host runs on: a line runs as the wsp this forwarder was handed, which answers
//! it in every word. A `wsp mcp` line that names where its tools go is served before it reaches here, by the tool
//! server in the binary the forwarder runs from; this is every other line.

use crate::REFUSED;

/// Replaces this process with the wsp it was handed, so what the person reads and the code they get are that wsp's
/// own.
pub fn run_here(line: &[String], wsp: &[String]) -> i32 {
    let Some((program, args)) = wsp.split_first() else {
        eprintln!("wsp: no command to run");
        return REFUSED;
    };
    use std::os::unix::process::CommandExt;
    let e = std::process::Command::new(program).args(args).args(line).exec();
    eprintln!("wsp: {program}: {e}");
    REFUSED
}
