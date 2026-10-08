// SPDX-License-Identifier: AGPL-3.0-only
//! Which socket roads serve the ops that are a guest's or the host's alone, whichever daemon a frame reaches.

use crate::ops::Road;

/// Which of the guest road's five ops a socket on this road serves. A guest process lives inside a machine wsp
/// forked, inside a workspace on a computer somebody owns and in a thread on that computer itself, so its two ops
/// are served on the inbound socket of a daemon inside a machine, on a workspace's own socket and on the
/// computer's, and nowhere else. The host is on the inbound socket of a daemon inside a machine and on the other
/// end of the link of a place's daemon, so its three are served there: a client holding the token of a computer
/// somebody owns cannot take the sessions its host watches.
pub(crate) fn guest_road_serves(road: &Road, place: bool, op: &str) -> bool {
    let guests = matches!(op, "guest.open" | "guest.send");
    match road {
        Road::Workspace(_) | Road::Computer => guests,
        Road::Inbound => !place,
        Road::Link => place && !guests,
    }
}

/// Whether a socket on this road is the host's, for an op that reads the person's own files beside wsp's: the
/// inbound socket of a daemon that is no place and the link of one that is, never a socket inside a workspace.
pub(crate) fn host_road_serves(road: &Road, place: bool) -> bool {
    match road {
        Road::Workspace(_) | Road::Computer => false,
        Road::Inbound => !place,
        Road::Link => place,
    }
}
