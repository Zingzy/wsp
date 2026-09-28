// SPDX-License-Identifier: AGPL-3.0-only
//! A host somewhere else, on loopback: the key it proves at seal.open held to the one this computer pinned before the
//! token crosses, on the account's road and on the address a turn's launch left, every frame after that reply sealed
//! both ways, a frame in the clear after it ending the socket, and a host on the account admitting this computer on its
//! device key and the token it answers written into the record, or refusing it in one of the two ways a host can.

use std::path::Path;
use std::sync::{Arc, Mutex};

use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use wsp_frames::{
    place_link_transcript, Base64Bytes, LinkEphemerals, LinkRole, PlaceEphemeral, PlaceNonce, PlacePublicKey, PlaceSignature,
};
use wsp_mcp::{Args, Env};
use wsp_seal::Seal;

const TOKEN: &str = "device-token-held";
const MINTED: &str = "device-token-minted";
const CLIENT: &str = "client";

fn words() -> Value {
    serde_json::from_str(include_str!("../record/words.json")).unwrap()
}

fn fresh_key() -> SigningKey {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    SigningKey::from_bytes(&seed)
}

fn spki(key: &SigningKey) -> PlacePublicKey {
    Base64Bytes::from_bytes(&key.verifying_key().to_public_key_der().unwrap().as_bytes().try_into().unwrap())
}

/// How the host answers seal.open: with the key this computer pinned, with another key, or with the pinned key
/// signing bytes that are not the transcript.
#[derive(Clone, Copy, PartialEq)]
enum Proves {
    Pinned,
    Another,
    Forged,
}

/// How the host answers device.auth: with a token, as an older host whose door knows no such frame (no kind, then the
/// unauthorized close), or with a refusal in its own words.
#[derive(Clone, Copy, PartialEq)]
enum Admits {
    Yes,
    OlderHost,
    Refuses,
}

/// A host's own sentence for an admission it will not make, with the bytes a line has to carry as they came.
const REFUSED_ADMISSION: &str = "this host admits no computer on \u{85}that key; ask \"the owner\"";

/// What the host does after the seal: how it answers each op, and whether it answers the token in the clear.
#[derive(Clone)]
struct Script {
    proves: Proves,
    takes: &'static str,
    clear: bool,
    admits: Admits,
}

/// Every op the host read inside the seal on each socket, and the close each socket ended on.
#[derive(Default)]
struct Seen {
    sockets: Vec<Vec<Value>>,
    closes: Vec<Option<(u16, String)>>,
}

async fn host(pinned: SigningKey, script: Script) -> (u16, Arc<Mutex<Seen>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let noted = seen.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let socket = {
                noted.lock().unwrap().sockets.push(Vec::new());
                noted.lock().unwrap().sockets.len() - 1
            };
            let Some(Ok(Message::Text(text))) = ws.next().await else { continue };
            let open: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(open["op"], "seal.open", "the first frame is the seal, before any token");
            let (client_nonce, client_ephemeral) =
                (open["nonce"].as_str().unwrap().to_owned(), open["ephemeral"].as_str().unwrap().to_owned());
            let mut nonce = [0u8; 32];
            getrandom::fill(&mut nonce).unwrap();
            let nonce: PlaceNonce = Base64Bytes::from_bytes(&nonce);
            let (private, public) = wsp_seal::fresh_ephemeral().unwrap();
            let ephemeral: PlaceEphemeral = Base64Bytes::from_bytes(&public);
            let asked = LinkEphemerals { challenger: &client_ephemeral, answerer: ephemeral.as_str() };
            let transcript = place_link_transcript(LinkRole::Host, CLIENT, &client_nonce, nonce.as_str(), asked);
            let (proving, signed) = match script.proves {
                Proves::Pinned => (pinned.clone(), transcript),
                Proves::Another => (fresh_key(), transcript),
                Proves::Forged => (pinned.clone(), b"other bytes".to_vec()),
            };
            let signature: PlaceSignature = Base64Bytes::from_bytes(&proving.sign(&signed).to_bytes());
            let reply = json!({ "id": open["id"], "ok": true, "nonce": nonce.as_str(), "hostPublicKey": spki(&proving).as_str(), "signature": signature.as_str(), "ephemeral": ephemeral.as_str() });
            ws.send(Message::text(reply.to_string())).await.unwrap();
            let secret = wsp_seal::agree(private, &Base64Bytes::<32>::parse(&client_ephemeral).unwrap().to_bytes()).unwrap();
            let mut seal = Seal::host(&wsp_seal::seal_keys(&secret, CLIENT));
            let admitted = place_link_transcript(
                LinkRole::Place,
                CLIENT,
                nonce.as_str(),
                &client_nonce,
                LinkEphemerals { challenger: ephemeral.as_str(), answerer: &client_ephemeral },
            );
            let mut closed = None;
            while let Some(read) = ws.next().await {
                let frame: Value = match read {
                    Ok(Message::Binary(bytes)) => serde_json::from_str(&seal.unseal(&bytes).expect("a frame this side opens")).unwrap(),
                    Ok(Message::Close(frame)) => {
                        closed = frame.map(|f| (u16::from(f.code), f.reason.to_string()));
                        break;
                    }
                    Ok(Message::Text(text)) => panic!("after the seal every frame is sealed, got {text}"),
                    Ok(_) => continue,
                    Err(_) => break,
                };
                noted.lock().unwrap().sockets[socket].push(frame.clone());
                let body = match frame["op"].as_str().unwrap() {
                    "device.auth" if script.admits == Admits::OlderHost => json!({ "ok": false, "error": "invalid request" }),
                    "device.auth" if script.admits == Admits::Refuses => json!({ "ok": false, "error": REFUSED_ADMISSION, "kind": "auth" }),
                    "auth" if frame["token"] == script.takes => json!({ "ok": true }),
                    "auth" => json!({ "ok": false, "error": "that token opens nothing here", "kind": "auth" }),
                    "device.auth" => {
                        let key = Base64Bytes::<44>::parse(frame["publicKey"].as_str().unwrap()).unwrap();
                        let signature = Base64Bytes::<64>::parse(frame["signature"].as_str().unwrap()).unwrap();
                        assert!(
                            wsp_seal::verify(&key.to_bytes(), &admitted, &signature.to_bytes()),
                            "the admission is signed over this socket's transcript"
                        );
                        json!({ "ok": true, "deviceId": "d-minted", "deviceToken": MINTED })
                    }
                    _ => json!({ "ok": true, "places": [] }),
                };
                let mut answer = body.as_object().unwrap().clone();
                answer.insert("id".to_owned(), frame["id"].clone());
                let text = Value::Object(answer).to_string();
                let sent = if script.clear { Message::text(text) } else { Message::Binary(seal.seal(&text).into()) };
                if ws.send(sent).await.is_err() {
                    break;
                }
                if frame["op"] == "device.auth" && script.admits == Admits::OlderHost {
                    let code = unauthorized_close();
                    let _ = ws.close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() })).await;
                    break;
                }
            }
            noted.lock().unwrap().closes.push(closed);
        }
    });
    (port, seen)
}

/// A home holding one account record for the host on that port, pinned to `pinned`, and this computer's device key.
fn home_at(dir: &Path, port: u16, pinned: &SigningKey, token: &str, device: &SigningKey) -> Env {
    let home = dir.join("home");
    std::fs::create_dir_all(home.join("hosts")).unwrap();
    // As `wsp hosts` writes a record, in its key order, which a written token must keep.
    let key = wsp_seal::fingerprint(&spki(pinned).to_bytes());
    let record = format!(
        "{{\n  \"url\": \"http://127.0.0.1:{port}\",\n  \"deviceId\": \"d-held\",\n  \"deviceToken\": \"{token}\",\n  \"hostKey\": \"{key}\",\n  \"pairedAt\": \"2026-09-28T00:00:00.000Z\",\n  \"via\": {{\n    \"kind\": \"account\",\n    \"hostId\": \"h-attic\"\n  }}\n}}\n"
    );
    std::fs::write(home.join("hosts").join("attic.json"), record).unwrap();
    let key = json!({ "publicKey": spki(device).as_str(), "privateKeyPem": device.to_pkcs8_pem(LineEnding::LF).unwrap().as_str() });
    std::fs::write(home.join("device-key.json"), key.to_string()).unwrap();
    [("WSP_HOME".to_owned(), home.to_string_lossy().into_owned())].into_iter().collect()
}

fn host_record() -> Value {
    serde_json::from_str(include_str!("../record/host.json")).unwrap()
}

fn unauthorized_close() -> u16 {
    host_record()["unauthorizedClose"].as_u64().unwrap() as u16
}

/// The line the server prints for one computers call, aimed at `host` where one is named.
async fn line_of(dir: &Path, env: &Env, host: Option<&str>) -> String {
    let asked = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "computers", "arguments": {} } });
    let args = Args { state: dir.join("state.json"), host: host.map(str::to_owned), ..Args::default() };
    let mut out = Vec::new();
    assert_eq!(wsp_mcp::serve(&args, env, format!("{asked}\n").as_bytes(), &mut out).await, 0);
    String::from_utf8(out).unwrap().trim_end_matches('\n').to_owned()
}

async fn computers(dir: &Path, env: &Env) -> Value {
    serde_json::from_str::<Value>(&line_of(dir, env, Some("attic")).await).unwrap()["result"].clone()
}

/// What a turn's launch leaves for a line: the host's address, the token for it and the fingerprint of its key.
fn launched_at(dir: &Path, port: u16, key: &SigningKey) -> Env {
    let names = host_record()["env"].clone();
    let name = |n: &str| names[n].as_str().unwrap().to_owned();
    [
        ("WSP_HOME".to_owned(), dir.join("home").to_string_lossy().into_owned()),
        (name("url"), format!("http://127.0.0.1:{port}")),
        (name("token"), TOKEN.to_owned()),
        (name("key"), wsp_seal::fingerprint(&spki(key).to_bytes())),
    ]
    .into_iter()
    .collect()
}

fn recorded(dir: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join("home/hosts/attic.json")).unwrap()).unwrap()
}

#[tokio::test]
async fn a_host_that_proves_another_key_is_refused_with_the_pair_key_refusal_before_the_token_crosses() {
    for proves in [Proves::Another, Proves::Forged] {
        let dir = tempfile::tempdir().unwrap();
        let pinned = fresh_key();
        let (port, seen) = host(pinned.clone(), Script { proves, takes: TOKEN, clear: false, admits: Admits::Yes }).await;
        let env = home_at(dir.path(), port, &pinned, TOKEN, &fresh_key());
        let printed = line_of(dir.path(), &env, Some("attic")).await;
        // The whole line the TypeScript server answers the same refusal with, its port the one this host bound.
        let sealed: Value = serde_json::from_str(include_str!("sealed.json")).unwrap();
        assert_eq!(printed, sealed["line"].as_str().unwrap().replace("{port}", &port.to_string()));
        let said = words()["pairKey"].as_str().unwrap().replace("{url}", &format!("http://127.0.0.1:{port}"));
        let result = serde_json::from_str::<Value>(&printed).unwrap()["result"].clone();
        assert_eq!(result["structuredContent"], json!({ "error": said, "class": "auth", "exit": 2 }));
        assert_eq!(seen.lock().unwrap().sockets, vec![Vec::<Value>::new()], "nothing of this computer's crossed");
    }
}

#[tokio::test]
async fn a_host_that_proves_the_pinned_key_is_asked_everything_inside_the_seal() {
    let dir = tempfile::tempdir().unwrap();
    let pinned = fresh_key();
    let (port, seen) = host(pinned.clone(), Script { proves: Proves::Pinned, takes: TOKEN, clear: false, admits: Admits::Yes }).await;
    let env = home_at(dir.path(), port, &pinned, TOKEN, &fresh_key());
    let result = computers(dir.path(), &env).await;
    assert_eq!(result.get("isError"), None, "{result}");
    let ops: Vec<Value> = seen.lock().unwrap().sockets[0].iter().map(|f| f["op"].clone()).collect();
    assert_eq!(ops[0], "auth");
    assert_eq!(seen.lock().unwrap().sockets[0][0]["token"], TOKEN);
    assert!(ops.contains(&json!("places.list")), "{ops:?}");
}

#[tokio::test]
async fn a_record_with_no_token_is_admitted_on_the_device_key_and_keeps_the_token_the_host_answers() {
    let dir = tempfile::tempdir().unwrap();
    let pinned = fresh_key();
    let device = fresh_key();
    let (port, seen) = host(pinned.clone(), Script { proves: Proves::Pinned, takes: MINTED, clear: false, admits: Admits::Yes }).await;
    let env = home_at(dir.path(), port, &pinned, "", &device);
    let before = std::fs::read_to_string(dir.path().join("home/hosts/attic.json")).unwrap();
    let result = computers(dir.path(), &env).await;
    assert_eq!(result.get("isError"), None, "{result}");
    let admission = seen.lock().unwrap().sockets[0][0].clone();
    assert_eq!(admission["op"], "device.auth");
    assert_eq!(admission["publicKey"], spki(&device).as_str());
    let kept = before.replace("\"d-held\"", "\"d-minted\"").replace("\"deviceToken\": \"\"", &format!("\"deviceToken\": \"{MINTED}\""));
    let written = std::fs::read_to_string(dir.path().join("home/hosts/attic.json")).unwrap();
    assert_eq!(written, kept, "the record in the order it was written, the token changed");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(dir.path().join("home/hosts/attic.json")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[tokio::test]
async fn a_token_the_host_took_away_is_one_more_dial_proving_the_device_key() {
    let dir = tempfile::tempdir().unwrap();
    let pinned = fresh_key();
    let (port, seen) = host(pinned.clone(), Script { proves: Proves::Pinned, takes: MINTED, clear: false, admits: Admits::Yes }).await;
    let env = home_at(dir.path(), port, &pinned, "a-token-taken-away", &fresh_key());
    let result = computers(dir.path(), &env).await;
    assert_eq!(result.get("isError"), None, "{result}");
    let sockets = seen.lock().unwrap().sockets.clone();
    assert_eq!(sockets.len(), 2, "{sockets:?}");
    assert_eq!(sockets[0], vec![json!({ "id": 2, "op": "auth", "token": "a-token-taken-away" })]);
    assert_eq!(sockets[1][0]["op"], "device.auth");
    assert_eq!(recorded(dir.path())["deviceToken"], MINTED);
}

#[tokio::test]
async fn a_frame_in_the_clear_after_the_seal_ends_the_socket() {
    let dir = tempfile::tempdir().unwrap();
    let pinned = fresh_key();
    let (port, seen) = host(pinned.clone(), Script { proves: Proves::Pinned, takes: TOKEN, clear: true, admits: Admits::Yes }).await;
    let env = home_at(dir.path(), port, &pinned, TOKEN, &fresh_key());
    let result = computers(dir.path(), &env).await;
    assert_eq!(result["isError"], true, "{result}");
    assert_eq!(result["structuredContent"]["error"], words()["hostClosed"]);
    let host: Value = serde_json::from_str(include_str!("../record/host.json")).unwrap();
    for _ in 0..50 {
        if !seen.lock().unwrap().closes.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(seen.lock().unwrap().closes, vec![Some((1002, host["sealRefusal"].as_str().unwrap().to_owned()))]);
}

#[tokio::test]
async fn the_address_a_launch_left_is_held_to_the_key_it_names_before_the_token_crosses() {
    for proves in [Proves::Another, Proves::Forged] {
        let dir = tempfile::tempdir().unwrap();
        let pinned = fresh_key();
        let (port, seen) = host(pinned.clone(), Script { proves, takes: TOKEN, clear: false, admits: Admits::Yes }).await;
        let printed = line_of(dir.path(), &launched_at(dir.path(), port, &pinned), None).await;
        let result = serde_json::from_str::<Value>(&printed).unwrap()["result"].clone();
        let said = words()["pairKey"].as_str().unwrap().replace("{url}", &format!("http://127.0.0.1:{port}"));
        assert_eq!(result["structuredContent"], json!({ "error": said, "class": "auth", "exit": 2 }));
        assert_eq!(seen.lock().unwrap().sockets, vec![Vec::<Value>::new()], "nothing of this computer's crossed");
    }
    let dir = tempfile::tempdir().unwrap();
    let pinned = fresh_key();
    let (port, seen) = host(pinned.clone(), Script { proves: Proves::Pinned, takes: TOKEN, clear: false, admits: Admits::Yes }).await;
    let printed = line_of(dir.path(), &launched_at(dir.path(), port, &pinned), None).await;
    let result = serde_json::from_str::<Value>(&printed).unwrap()["result"].clone();
    assert_eq!(result.get("isError"), None, "{result}");
    assert_eq!(seen.lock().unwrap().sockets[0][0], json!({ "id": 2, "op": "auth", "token": TOKEN }), "the token crossed inside the seal");
}

#[tokio::test]
async fn an_admission_an_older_host_does_not_know_says_that_host_runs_an_older_wsp() {
    let dir = tempfile::tempdir().unwrap();
    let pinned = fresh_key();
    let (port, _) = host(pinned.clone(), Script { proves: Proves::Pinned, takes: MINTED, clear: false, admits: Admits::OlderHost }).await;
    let env = home_at(dir.path(), port, &pinned, "", &fresh_key());
    let result = computers(dir.path(), &env).await;
    let said = words()["deviceAuthOldHost"].as_str().unwrap().replace("{where}", &format!("http://127.0.0.1:{port}"));
    assert_eq!(result["structuredContent"], json!({ "error": said, "class": "auth", "exit": 2 }));
    assert_eq!(recorded(dir.path())["deviceToken"], "", "no token was written");
}

#[tokio::test]
async fn an_admission_a_host_refuses_in_its_own_words_is_said_as_it_came() {
    let dir = tempfile::tempdir().unwrap();
    let pinned = fresh_key();
    let (port, seen) = host(pinned.clone(), Script { proves: Proves::Pinned, takes: MINTED, clear: false, admits: Admits::Refuses }).await;
    let env = home_at(dir.path(), port, &pinned, "", &fresh_key());
    let result = computers(dir.path(), &env).await;
    assert_eq!(result["structuredContent"], json!({ "error": REFUSED_ADMISSION, "class": "auth", "exit": 2 }));
    assert_eq!(seen.lock().unwrap().sockets.len(), 1, "a refused admission is not dialled again");
    assert_eq!(recorded(dir.path())["deviceToken"], "", "no token was written");
}
