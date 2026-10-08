// SPDX-License-Identifier: AGPL-3.0-only
//! The wsp a process inside a machine runs, as two lines of shell onto the binary that answers the word. The
//! host's deploy writes it on a fork and the workspace runtime writes it into a workspace's own upper on a
//! computer somebody owns; the text is here so the two roads cannot spell it apart, and the protocol's twin is
//! held to it by the contract fixture.

use crate::shell::shell_quote;

/// The shim at `numbers::GUEST_WSP_PATH`, handing the whole line to the binary named.
pub fn guest_wsp_shim(binary: &str) -> String {
    format!("#!/bin/sh\nexec {binary} wsp \"$@\"\n")
}

/// The wsp a thread on a computer somebody joined runs, which that computer's daemon writes in wsp's folder under
/// the login's home: the line goes to the door named and nowhere else. That computer's loopback port is anybody's
/// to bind and the token file beside it is its daemon's own, so a door that is missing is said, never routed around.
/// The daemon's unit rides along where it has one, so that sentence names the restart that opens the door again.
pub fn computer_wsp_shim(binary: &str, door: &str, unit: Option<&str>) -> String {
    let unit = unit.map(|unit| format!("{COMPUTER_WSP_UNIT_FLAG} {} ", shell_quote(unit))).unwrap_or_default();
    format!("#!/bin/sh\nexec {} {COMPUTER_WSP_VERB} {unit}{} \"$@\"\n", shell_quote(binary), shell_quote(door))
}

/// The verb that shim runs, the door its first word after it.
pub const COMPUTER_WSP_VERB: &str = "wsp-door";
/// The flag ahead of the door naming the daemon's unit.
pub const COMPUTER_WSP_UNIT_FLAG: &str = "--unit";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_computer_shim_names_its_door_and_no_port() {
        assert_eq!(
            computer_wsp_shim("/usr/local/bin/wsp-daemon", "/home/o'b/.wsp/daemon.sock", None),
            "#!/bin/sh\nexec '/usr/local/bin/wsp-daemon' wsp-door '/home/o'\\''b/.wsp/daemon.sock' \"$@\"\n"
        );
        assert_eq!(
            computer_wsp_shim("/d", "/root/.wsp/daemon.sock", Some("wsp-place-ecffdb75.service")),
            "#!/bin/sh\nexec '/d' wsp-door --unit 'wsp-place-ecffdb75.service' '/root/.wsp/daemon.sock' \"$@\"\n"
        );
    }

    #[test]
    fn the_shim_hands_the_line_on_whole_to_the_binary_it_names() {
        assert_eq!(guest_wsp_shim("/sbin/wsp-init"), "#!/bin/sh\nexec /sbin/wsp-init wsp \"$@\"\n");
    }
}
