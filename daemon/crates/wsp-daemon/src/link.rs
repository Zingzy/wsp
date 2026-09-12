// SPDX-License-Identifier: AGPL-3.0-only
//! The outbound half of a place: this computer dials its host instead of listening for it, proves who it is with
//! the ed25519 key the host learned at join, and then hands that one socket to the same loop an inbound one gets.
//! Nothing here opens a port. The bytes both sides sign come from the protocol's transcript, so this file holds
//! the place's half of the handshake and no rule of its own about how it is spelled.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{timeout_at, Instant};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wsp_frames::{
    is_http_url, numbers, place_link_transcript, words, Base64Bytes, LinkRole, PlaceAuthReply, PlaceAuthRequest, PlaceFile, PlaceNonce,
    PlaceProveRequest, RequestId,
};

use crate::door::{self, Ended};
use crate::ops::{Conn, Road};
use crate::place::{self, AgentBin, ReportInput};
use crate::{Ctx, Outbound};

/// How long each address gets to answer the connect and each frame of the handshake.
const CONNECT_MS: u64 = 10_000;
/// How long a link may carry no frame before it is cut: the host pings every ten seconds, so three missed beats.
const QUIET_MS: u64 = 30_000;
/// How long a refused link waits. The host holds no such place, so nothing changes until a person acts.
const REFUSED_RETRY_MS: u64 = 10 * 60_000;
/// A link that stood this long was a working link, so the next redial starts from the bottom of the backoff.
const SETTLED: Duration = Duration::from_secs(60);
/// How long the peer gets to answer a close frame this side sent before the socket is dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// The wait before attempt n: two seconds doubling to thirty.
pub fn place_backoff_ms(attempt: u32) -> u64 {
    (2_000u64 << attempt.saturating_sub(1).min(4)).min(30_000)
}

/// Four fifths to six fifths of the wait, so a hundred places that lost one host do not all come back at once.
fn jittered(ms: u64, draw: f64) -> u64 {
    (ms as f64 * (0.8 + 0.4 * draw)).round() as u64
}

/// A draw in [0, 1) from the system's randomness.
fn draw() -> f64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0.5;
    }
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

fn fresh_nonce() -> PlaceNonce {
    let mut bytes = [0u8; numbers::PLACE_LINK_NONCE_BYTES];
    // The system's randomness is the one source; without it there is no nonce and no handshake worth sending.
    getrandom::fill(&mut bytes).expect("the system gives random bytes");
    Base64Bytes::from_bytes(&bytes)
}

/// The protocol's wsUrlOf: the scheme turned to its socket form, the host kept, trailing slashes cut, the socket
/// path appended. Only http addresses are dialled here: nothing in this daemon speaks TLS yet.
pub(crate) fn ws_url_of(url: &str) -> Result<String, &'static str> {
    if !is_http_url(url) {
        return Err("not an http address");
    }
    let (scheme, rest) = url.split_once("://").ok_or("not an http address")?;
    if scheme.eq_ignore_ascii_case("https") {
        return Err("this daemon dials http addresses only; it holds no TLS");
    }
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let (host, path) = match rest.find('/') {
        Some(at) => (&rest[..at], rest[at..].trim_end_matches('/')),
        None => (rest, ""),
    };
    if host.is_empty() {
        return Err("not an http address");
    }
    Ok(format!("ws://{host}{path}/ws"))
}

/// Whole seconds as node's Math.round gives them for the two sentences that name a wait.
fn seconds(ms: u64) -> u64 {
    (ms as f64 / 1000.0).round() as u64
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What one address gave: a proved socket to hold, a host that says this place is not one it knows, or an address
/// to pass over for the next.
enum Outcome {
    Linked(Box<Socket>),
    Refused,
    Skipped,
}

/// One pass over every address in the place file ended with a link held and then lost, a refusal, or every address
/// skipped; each has its own wait.
enum Pass {
    Held,
    Refused,
    Skipped,
}

struct Link {
    ctx: Arc<Ctx>,
    daemon_port: u16,
    file: std::path::PathBuf,
    home: std::path::PathBuf,
    agents: Vec<AgentBin>,
    connect: Duration,
    quiet: Duration,
    refused_retry: u64,
    fixed_backoff: Option<u64>,
}

/// The link this daemon holds outward while it runs; returns only once a leave has been answered, which is what
/// ends the daemon.
pub(crate) async fn run(ctx: Arc<Ctx>, daemon_port: u16) {
    let o = &ctx.options;
    let Some(file) = o.place_file.clone() else { return };
    let link = Link {
        home: place::place_home(o.home.as_deref()),
        agents: place::parse_agents(&o.agents),
        connect: Duration::from_millis(o.link_connect_ms.unwrap_or(CONNECT_MS)),
        quiet: Duration::from_millis(o.link_quiet_ms.unwrap_or(QUIET_MS)),
        refused_retry: o.link_refused_retry_ms.unwrap_or(REFUSED_RETRY_MS),
        fixed_backoff: o.link_backoff_ms,
        file,
        daemon_port,
        ctx: Arc::clone(&ctx),
    };
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let Some(file) = place::read_place_file(&link.file) else {
            link.log(words::NO_PLACE_FILE);
            link.wait(link.refused_retry).await;
            continue;
        };
        let mut pass = Pass::Skipped;
        for url in &file.host_urls {
            match link.handshake(&file, url).await {
                Outcome::Skipped => continue,
                Outcome::Refused => {
                    pass = Pass::Refused;
                    break;
                }
                Outcome::Linked(ws) => {
                    let linked_at = Instant::now();
                    match link.hold(*ws, url).await {
                        Ended::Leave => return,
                        Ended::Quiet => link.log(&words::link_quiet(url, seconds(link.quiet.as_millis() as u64))),
                        Ended::Peer => {}
                    }
                    // A link that stood a minute was a working link: the next one starts from the bottom of the
                    // backoff rather than from wherever a laptop that slept for an hour left it.
                    if linked_at.elapsed() > SETTLED {
                        attempt = 0;
                    }
                    pass = Pass::Held;
                    break;
                }
            }
        }
        let ms = match pass {
            Pass::Refused => link.refused_retry,
            Pass::Held => link.backoff(attempt + 1),
            Pass::Skipped => link.backoff(attempt),
        };
        link.wait(ms).await;
    }
}

impl Link {
    fn log(&self, line: &str) {
        self.ctx.log(line);
    }

    fn backoff(&self, attempt: u32) -> u64 {
        self.fixed_backoff.unwrap_or_else(|| place_backoff_ms(attempt))
    }

    async fn wait(&self, ms: u64) {
        tokio::time::sleep(Duration::from_millis(jittered(ms, draw()))).await;
    }

    /// One address: open, auth, verify the host, prove. The deadline covers the connect and both handshake frames.
    async fn handshake(&self, file: &PlaceFile, url: &str) -> Outcome {
        let target = match ws_url_of(url) {
            Ok(target) => target,
            Err(why) => {
                self.log(&words::link_could_not_dial(url, why));
                return Outcome::Skipped;
            }
        };
        let deadline = Instant::now() + self.connect;
        let mut ws = match timeout_at(deadline, connect_async(&target)).await {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(_)) => {
                self.log(&words::link_no_answer_to_dial(url));
                return Outcome::Skipped;
            }
            Err(_) => {
                self.log(&words::link_no_answer_in(url, seconds(self.connect.as_millis() as u64)));
                return Outcome::Skipped;
            }
        };
        let nonce = fresh_nonce();
        let auth = PlaceAuthRequest::new(RequestId::from(1), file.place_id.clone(), nonce.clone());
        if ws.send(Message::text(crate::frame_text(&auth))).await.is_err() {
            self.log(&words::link_no_answer_to_dial(url));
            return Outcome::Skipped;
        }
        loop {
            let frame = match timeout_at(deadline, ws.next()).await {
                Err(_) => {
                    self.log(&words::link_no_answer_in(url, seconds(self.connect.as_millis() as u64)));
                    return self.cut(ws, Outcome::Skipped).await;
                }
                Ok(Some(Ok(Message::Text(t)))) => t.to_string(),
                Ok(Some(Ok(Message::Binary(b)))) => String::from_utf8_lossy(&b).into_owned(),
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)))) => continue,
                Ok(_) => {
                    self.log(&words::link_no_answer_to_dial(url));
                    return Outcome::Skipped;
                }
            };
            let Ok(value) = serde_json::from_str::<Value>(&frame) else {
                self.log(&words::link_not_a_frame(url));
                return self.cut(ws, Outcome::Skipped).await;
            };
            if value.get("ok") != Some(&Value::Bool(true)) {
                // The host answered the handshake with a refusal: this place is not one it holds, or its key moved.
                let line = value.get("error").and_then(Value::as_str).unwrap_or(words::HOST_REFUSED_PLACE);
                self.log(&words::link_refused(url, line));
                return self.cut(ws, Outcome::Refused).await;
            }
            match value.get("id").and_then(Value::as_u64) {
                Some(1) => {
                    let reply = match serde_json::from_value::<PlaceAuthReply>(value.clone()) {
                        Ok(reply) => reply,
                        Err(e) => {
                            self.log(&words::link_unreadable_auth_reply(url, &e.to_string()));
                            return self.cut(ws, Outcome::Skipped).await;
                        }
                    };
                    let host_bytes = place_link_transcript(LinkRole::Host, &file.place_id, nonce.as_str(), reply.nonce.as_str());
                    let proved = reply.host_public_key.as_str() == file.host_public_key
                        && place::verify_place_bytes(&reply.host_public_key, &host_bytes, &reply.signature);
                    if !proved {
                        // Nothing of this computer's has been sent yet: the report and the place's own signature
                        // are the next frame, and the attempt ends before it.
                        self.log(&words::host_key_refusal(url));
                        return self.cut(ws, Outcome::Skipped).await;
                    }
                    let prove = match self.prove(file, url, reply.nonce.as_str(), nonce.as_str()) {
                        Ok(prove) => prove,
                        Err(why) => {
                            self.log(&words::link_refused(url, &why));
                            return self.cut(ws, Outcome::Skipped).await;
                        }
                    };
                    if ws.send(Message::text(crate::frame_text(&prove))).await.is_err() {
                        self.log(&words::link_no_answer_to_dial(url));
                        return Outcome::Skipped;
                    }
                }
                Some(2) => return Outcome::Linked(Box::new(ws)),
                _ => continue,
            }
        }
    }

    /// The second frame: this place's signature over the host's transcript and its report as it stands now.
    fn prove(&self, file: &PlaceFile, url: &str, host_nonce: &str, my_nonce: &str) -> Result<PlaceProveRequest, String> {
        let pem = std::fs::read_to_string(Path::new(&file.key_path)).map_err(|e| format!("{}: {e}", file.key_path))?;
        let report = place::place_report(&ReportInput {
            file,
            home: &self.home,
            wsp_argv: &self.ctx.options.wsp_argv,
            agents: &self.agents,
            daemon_port: self.daemon_port,
            dialed: url,
        });
        let signature = place::sign_place_bytes(&pem, &place_link_transcript(LinkRole::Place, &file.place_id, host_nonce, my_nonce))?;
        Ok(PlaceProveRequest::new(RequestId::from(2), signature, report))
    }

    /// Ends an attempt on a socket this side is walking away from, with node's close reason.
    async fn cut(&self, mut ws: Socket, outcome: Outcome) -> Outcome {
        let frame = CloseFrame { code: CloseCode::Normal, reason: words::LINK_CLOSE_ATTEMPT_OVER.into() };
        let _ = tokio::time::timeout(CLOSE_WAIT, async {
            let _ = ws.close(Some(frame)).await;
            while let Some(Ok(_)) = ws.next().await {}
        })
        .await;
        outcome
    }

    /// The socket is this place's link from here: the daemon serves it as it serves an inbound one, the link's own
    /// ops ride it, and a link that carries no frame at all is cut so the redial can find a host that is there.
    async fn hold(&self, ws: Socket, url: &str) -> Ended {
        self.log(&words::link_linked(url));
        let (tx, rx) = mpsc::unbounded_channel();
        let conn = Arc::new(Conn::new(None, Outbound(tx), Road::Link));
        door::serve_authed(ws, &self.ctx, conn, rx, Some(self.quiet)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wait_doubles_from_two_seconds_to_thirty_and_stops_there() {
        assert_eq!([1, 2, 3, 4, 5, 6].map(place_backoff_ms), [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
        assert_eq!(place_backoff_ms(0), 2_000);
    }

    #[test]
    fn the_jitter_is_four_fifths_to_six_fifths_of_the_wait() {
        assert_eq!(jittered(10_000, 0.0), 8_000);
        assert_eq!(jittered(10_000, 0.5), 10_000);
        assert_eq!(jittered(10_000, 1.0), 12_000);
        for _ in 0..100 {
            let d = draw();
            assert!((0.0..1.0).contains(&d));
        }
    }

    #[test]
    fn the_socket_address_is_the_protocols_reading_of_the_http_one() {
        assert_eq!(ws_url_of("http://192.168.1.20:4400").unwrap(), "ws://192.168.1.20:4400/ws");
        assert_eq!(ws_url_of("http://192.168.1.20:4400/").unwrap(), "ws://192.168.1.20:4400/ws");
        assert_eq!(ws_url_of("http://host.example/base//").unwrap(), "ws://host.example/base/ws");
        assert_eq!(ws_url_of("HTTP://h:1?x=1").unwrap(), "ws://h:1/ws");
        assert!(ws_url_of("https://relay.example.com").is_err());
        assert!(ws_url_of("ftp://h").is_err());
        assert!(ws_url_of("http://").is_err());
        assert!(ws_url_of("http:///path").is_err());
    }

    #[test]
    fn the_nonce_is_thirty_two_fresh_bytes() {
        let a = fresh_nonce();
        let b = fresh_nonce();
        assert_ne!(a, b);
        assert_eq!(a.to_bytes().len(), 32);
        assert_eq!(seconds(10_000), 10);
        assert_eq!(seconds(120), 0);
        assert_eq!(seconds(1_500), 2);
    }
}
