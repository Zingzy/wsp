// SPDX-License-Identifier: AGPL-3.0-only
//! The op switch's ptys and port watches, as a socket asks for them.

use serde_json::json;

use super::{bench, conn, reply};
#[cfg(target_os = "linux")]
use super::{conn_on, place_bench};
#[cfg(target_os = "linux")]
use crate::ops::Road;

#[cfg(target_os = "linux")]
#[tokio::test]
async fn named_port_watches_on_one_socket_keep_their_own_roots_beside_its_own_watch() {
    let b = place_bench();
    let (c, _rx) = conn_on(None, Road::Link);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let group = nix::unistd::getpgrp().as_raw();
    let ports_of = |reply: &serde_json::Value| -> Vec<u64> {
        reply["ports"].as_array().unwrap().iter().map(|p| p["port"].as_u64().unwrap()).collect()
    };
    let mine = reply(&b, &c, json!({"id": 1, "op": "ports.watch", "roots": [group], "watch": "ws_a"})).await;
    assert!(ports_of(&mine).contains(&u64::from(port)), "{mine}");
    let theirs = reply(&b, &c, json!({"id": 2, "op": "ports.watch", "roots": [999_999], "watch": "ws_b"})).await;
    assert!(!ports_of(&theirs).contains(&u64::from(port)), "{theirs}");
    // A second ask under the first name names its roots again and leaves the other name as it was.
    let again = reply(&b, &c, json!({"id": 3, "op": "ports.watch", "roots": [group], "watch": "ws_a"})).await;
    assert!(ports_of(&again).contains(&u64::from(port)), "{again}");
    assert_eq!(c.port_watches.lock().unwrap().len(), 2);
    let whole = reply(&b, &c, json!({"id": 4, "op": "ports.watch"})).await;
    assert!(ports_of(&whole).contains(&u64::from(port)), "the socket's own watch still sees the whole computer: {whole}");
    let bad = reply(&b, &c, json!({"id": 5, "op": "ports.watch", "watch": "a b"})).await;
    assert_eq!(bad["ok"], false, "{bad}");
    drop(listener);
}

/// The pty ops for a workspace, on a daemon that runs none, which is every machine wsp forked and this bench.
/// What the frame has to carry is read before the workspace is looked up, since a pty with no folder would
/// open a shell in the computer's own home, which every workspace here has bound in; and a workspace this
/// daemon does not run is the one missing refusal every other op answers for one.
#[tokio::test]
async fn a_pty_for_a_workspace_names_its_folder_and_a_workspace_this_daemon_runs() {
    let b = bench();
    let (c, _rx) = conn(None);
    // No folder at all, and one that is not absolute: a bad request before anything is looked up.
    let none = reply(&b, &c, json!({"id": 1, "op": "pty.create", "machineId": "wsp-x"})).await;
    assert_eq!(none, json!({"id": 1, "ok": false, "code": "bad-request", "error": "a pty inside wsp-x needs the folder it opens in"}));
    let relative = reply(&b, &c, json!({"id": 2, "op": "pty.create", "machineId": "wsp-x", "cwd": "project"})).await;
    assert_eq!(relative, json!({"id": 2, "ok": false, "code": "bad-request", "error": "project is not an absolute path inside wsp-x"}));
    // And with both: the workspace, which this daemon does not run.
    let gone = reply(&b, &c, json!({"id": 3, "op": "pty.create", "machineId": "wsp-x", "cwd": "/root/project"})).await;
    assert_eq!(gone, json!({"id": 3, "ok": false, "code": "not-found", "error": "no such workspace: wsp-x"}));
    // Every other pty op naming a workspace answers for a pty of that workspace, and this daemon holds none:
    // a pane of one workspace never reaches a pty of another or of the computer itself.
    for op in ["pty.attach", "pty.write", "pty.resize", "pty.detach", "pty.kill"] {
        let said =
            reply(&b, &c, json!({"id": 4, "op": op, "ptyId": "pty_1", "machineId": "wsp-x", "data": "x", "cols": 80, "rows": 24})).await;
        assert_eq!(said, json!({"id": 4, "ok": false, "error": "no such pty: pty_1"}), "{op}");
    }
    // And the listing is the machine's the frame named: this daemon's own where it named none, and a
    // workspace's where it did, which here is empty either way.
    assert_eq!(reply(&b, &c, json!({"id": 5, "op": "pty.list"})).await, json!({"id": 5, "ok": true, "ptys": []}));
    assert_eq!(reply(&b, &c, json!({"id": 6, "op": "pty.list", "machineId": "wsp-x"})).await, json!({"id": 6, "ok": true, "ptys": []}));
}

/// A pty of this computer's own is not reachable by naming a workspace, and the shell the daemon opened for
/// itself is listed for this computer and for no workspace.
#[tokio::test]
async fn a_pty_of_this_computer_is_no_workspaces_pty() {
    let b = bench();
    let (c, _rx) = conn(None);
    let made = reply(&b, &c, json!({"id": 1, "op": "pty.create", "shell": "bash"})).await;
    assert_eq!(made["ok"], json!(true), "{made}");
    let pty_id = made["ptyId"].as_str().unwrap().to_owned();
    for op in ["pty.attach", "pty.write", "pty.resize", "pty.detach", "pty.kill"] {
        let said =
            reply(&b, &c, json!({"id": 2, "op": op, "ptyId": &pty_id, "machineId": "wsp-a", "data": "x", "cols": 80, "rows": 24})).await;
        assert_eq!(said["error"], json!(format!("no such pty: {pty_id}")), "{op}");
    }
    let listed = reply(&b, &c, json!({"id": 3, "op": "pty.list"})).await;
    assert_eq!(listed["ptys"].as_array().unwrap().len(), 1, "{listed}");
    assert_eq!(listed["ptys"][0]["id"], json!(pty_id));
    let inside = reply(&b, &c, json!({"id": 4, "op": "pty.list", "machineId": "wsp-a"})).await;
    assert_eq!(inside, json!({"id": 4, "ok": true, "ptys": []}));
    assert_eq!(reply(&b, &c, json!({"id": 5, "op": "pty.kill", "ptyId": &pty_id})).await, json!({"id": 5, "ok": true}));
}
