// SPDX-License-Identifier: AGPL-3.0-only
//! The roads on a computer's link: what a frame naming no road, the computer's own, or one workspace is answered.

use super::*;
use wsp_frames::FORK_OPS;

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_link_frame_that_names_no_road_is_refused_and_one_naming_the_computer_runs_there() {
    let b = place_bench();
    let (ctx, home) = (Arc::clone(&b.ctx), &b.root);
    let (link, _rx) = conn_on(None, Road::Link);
    let ran = home.path().join("ran");
    let exec = json!({"id": 1, "op": "exec", "cmd": format!("touch {}", ran.display())});
    let said: Value = serde_json::from_str(handle(&link, &ctx, &exec.to_string()).await.text()).unwrap();
    assert_eq!(said, json!({"id": 1, "ok": false, "error": words::ROAD_UNNAMED, "code": "forbidden"}));
    assert!(!ran.exists(), "a frame naming no road ran on the computer");
    let leave: Value = serde_json::from_str(handle(&link, &ctx, &json!({"id": 2, "op": "place.leave"}).to_string()).await.text()).unwrap();
    assert_eq!(leave["error"], json!(words::ROAD_UNNAMED));

    let mut on_computer = exec.clone();
    on_computer["road"] = json!(numbers::COMPUTER_ROAD);
    let said: Value = serde_json::from_str(handle(&link, &ctx, &on_computer.to_string()).await.text()).unwrap();
    assert_eq!(said["ok"], json!(true), "{said}");
    assert!(ran.exists(), "a frame naming the computer's road did not run there");
    // A machine op names the machine it acts on and is the runtime's, so it takes no road word.
    let listed: Value =
        serde_json::from_str(handle(&link, &ctx, &json!({"id": 3, "op": "machine.list"}).to_string()).await.text()).unwrap();
    assert_ne!(listed["error"], json!(words::ROAD_UNNAMED));
}

/// Every op the daemon knows, sent on the link naming one workspace: the ones that workspace's road carries are
/// answered inside it (here, refused for a workspace this computer does not run), and every other one is refused
/// on the road before it runs, whatever else the frame says.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_link_frame_naming_a_workspace_carries_only_the_ops_answered_inside_it() {
    let b = place_bench();
    let (ctx, home) = (Arc::clone(&b.ctx), &b.root);
    let (link, _rx) = conn_on(None, Road::Link);
    let ran = home.path().join("ran");
    for op in DAEMON_OPS {
        let frame =
            json!({"id": 4, "op": op, "machineId": "wsp-x", "road": numbers::COMPUTER_ROAD, "cmd": format!("touch {}", ran.display())});
        let said: Value = serde_json::from_str(handle(&link, &ctx, &frame.to_string()).await.text()).unwrap();
        if FORK_OPS.contains(&op) {
            assert_ne!(said["error"], json!(words::NOT_ON_THIS_ROAD), "{op} is a workspace's op and was refused on its road");
        } else {
            assert_eq!(said, json!({"id": 4, "ok": false, "error": words::NOT_ON_THIS_ROAD, "code": "forbidden"}), "{op}");
        }
    }
    assert!(!ran.exists(), "an exec naming a workspace ran on the computer");
    for op in ["exec", "proc.watch", "ports.watch", "sys.watch", "place.leave", "place.update", "fs.folders", "manifest.get", "inbox.watch"]
    {
        assert_eq!(FORK_OPS.contains(&op), op.starts_with("proc."), "{op}");
    }
    for op in FORK_OPS {
        assert!(DAEMON_OPS.contains(&op), "{op} is on a workspace's road and is no op of this daemon");
    }
}

/// Every road on a link rides one socket, so a tunnel and a guest session answer only the road that opened them:
/// the computer's own tunnel takes no byte and no close from a frame naming a workspace, and a session opened
/// inside one workspace takes no reply and no close from another's road.
#[tokio::test]
async fn a_tunnel_and_a_guest_session_answer_only_the_road_that_opened_them() {
    let b = place_bench();
    let (link, _rx) = conn_on(None, Road::Link);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let opened = reply(&b, &link, json!({"id": 1, "op": "tunnel.open", "tunnelId": "pl1", "port": port, "road": "computer"})).await;
    assert_eq!(opened, json!({"id": 1, "ok": true}));
    let (mut accepted, _) = listener.accept().await.unwrap();
    let refused = |id: i64| json!({"id": id, "ok": false, "code": "forbidden", "error": words::NOT_ON_THIS_ROAD});
    assert_eq!(
        reply(&b, &link, json!({"id": 2, "op": "tunnel.write", "tunnelId": "pl1", "data": "aGk=", "machineId": "wsp-x"})).await,
        refused(2)
    );
    assert_eq!(reply(&b, &link, json!({"id": 3, "op": "tunnel.close", "tunnelId": "pl1", "machineId": "wsp-x"})).await, refused(3));
    assert_eq!(
        reply(&b, &link, json!({"id": 4, "op": "tunnel.write", "tunnelId": "pl1", "data": "b2s=", "road": "computer"})).await,
        json!({"id": 4, "ok": true})
    );
    let mut got = [0u8; 2];
    tokio::io::AsyncReadExt::read_exact(&mut accepted, &mut got).await.unwrap();
    assert_eq!(&got, b"ok", "the tunnel took bytes from another road");
    assert_eq!(
        reply(&b, &link, json!({"id": 5, "op": "tunnel.close", "tunnelId": "pl1", "road": "computer"})).await,
        json!({"id": 5, "ok": true})
    );

    assert_eq!(reply(&b, &link, json!({"id": 6, "op": "guest.watch", "road": "computer"})).await["ok"], json!(true));
    let (a_side, mut a_events) = conn_on(None, Road::Workspace("wsp-a".to_owned()));
    let open = json!({"id": 7, "op": "guest.open", "kind": "cli", "token": "", "argv": [], "cwd": "/root"});
    let session = reply(&b, &a_side, open).await["session"].as_str().unwrap().to_owned();
    let answer =
        |id: i64, op: &str, machine: &str| json!({"id": id, "op": op, "session": session, "message": {"exit": 0}, "machineId": machine});
    assert_eq!(reply(&b, &link, answer(8, "guest.reply", "wsp-b")).await, refused(8));
    assert_eq!(reply(&b, &link, answer(9, "guest.close", "wsp-b")).await, refused(9));
    assert!(a_events.try_recv().is_err(), "a session heard a frame from another workspace's road");
    assert_eq!(reply(&b, &link, answer(10, "guest.reply", "wsp-a")).await, json!({"id": 10, "ok": true}));
    let down: Value = serde_json::from_str(a_events.recv().await.unwrap().text()).unwrap();
    assert_eq!(down["message"], json!({"exit": 0}));
    assert_eq!(reply(&b, &link, answer(11, "guest.close", "wsp-a")).await, json!({"id": 11, "ok": true}));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_proc_op_naming_a_workspace_this_computer_does_not_run_signals_and_reads_nothing() {
    let b = place_bench();
    let ctx = Arc::clone(&b.ctx);
    let (link, _rx) = conn_on(None, Road::Link);
    let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
    let pid = child.id();
    for frame in [
        json!({"id": 5, "op": "proc.kill", "pid": pid, "signal": "KILL", "machineId": "wsp-x"}),
        json!({"id": 5, "op": "proc.inspect", "pid": pid, "machineId": "wsp-x"}),
        json!({"id": 5, "op": "proc.watch", "machineId": "wsp-x"}),
    ] {
        let said: Value = serde_json::from_str(handle(&link, &ctx, &frame.to_string()).await.text()).unwrap();
        assert_eq!(said, json!({"id": 5, "ok": false, "error": wsp_runtime::no_such_workspace("wsp-x"), "code": "not-found"}), "{frame}");
    }
    assert!(child.try_wait().unwrap().is_none(), "the kill naming another workspace signalled a process of the computer");
    child.kill().unwrap();
    child.wait().unwrap();
}
