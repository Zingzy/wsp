// SPDX-License-Identifier: AGPL-3.0-only
//! The road a frame on a computer's link names, which every daemon op there must: the computer's own or one workspace.

use serde_json::Value;
use wsp_frames::{numbers, words, DAEMON_OPS, FORK_OPS};

/// Which road a frame on the link names: one workspace by its machine id, or the computer itself by the road word.
/// The machine id decides where both are there, since it is the narrower of the two.
#[derive(Debug, PartialEq, Eq)]
enum LinkRoad<'a> {
    Computer,
    Workspace(&'a str),
}

fn link_road(frame: &Value) -> Option<LinkRoad<'_>> {
    if let Some(machine) = frame.get("machineId").and_then(Value::as_str) {
        return Some(LinkRoad::Workspace(machine));
    }
    (frame.get("road").and_then(Value::as_str) == Some(numbers::COMPUTER_ROAD)).then_some(LinkRoad::Computer)
}

/// Why a daemon op on the link is not this daemon's to run where it stands: every frame the host sends there names
/// its road, so one that names neither is refused rather than run on the computer, and one naming a workspace
/// carries only what is answered inside that workspace. The machine ops are the runtime's, each naming the machine
/// it acts on, and an op this daemon does not know is left to the unknown-op answer.
pub(super) fn off_its_road(frame: &Value, op: Option<&str>) -> Option<&'static str> {
    let op = op.filter(|name| DAEMON_OPS.contains(name))?;
    match link_road(frame) {
        None => Some(words::ROAD_UNNAMED),
        Some(LinkRoad::Workspace(_)) if !FORK_OPS.contains(&op) => Some(words::NOT_ON_THIS_ROAD),
        Some(_) => None,
    }
}
