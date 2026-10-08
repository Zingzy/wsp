// SPDX-License-Identifier: AGPL-3.0-only
//! Which road a socket came in on, which decides what it may ask.

/// Which road a socket came in on: dialled by a client of this machine, opened outward by this place to its host,
/// or opened inside one workspace this computer runs, on that workspace's own socket, or on the socket a thread
/// running on this computer itself reaches its host through. The leave op and every machine op but the two
/// read-only ones are the link's alone, and a socket a guest opened reaches nothing of the computer it sits on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Road {
    Inbound,
    Link,
    Workspace(String),
    Computer,
}

impl Road {
    /// Whether a guest process opened this socket, which takes no token and answers its own two ops alone.
    pub(crate) fn guests(&self) -> bool {
        matches!(self, Road::Workspace(_) | Road::Computer)
    }
}
