// SPDX-License-Identifier: AGPL-3.0-only
//! The door: with the server on 0.0.0.0 the first frame is the only gate, so no handler exists until it passes.
//! Bytes are counted on the TCP stream under the WebSocket framing, because a frame is assembled whole before it is
//! a message and a peer that never finishes one would otherwise be buffered up to the framing's own cap.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{timeout, timeout_at, Instant};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;
use wsp_frames::{numbers, words, DaemonAuthRequest, DaemonEvent, Empty, Reply};

use crate::ops::{self, Conn, Road};
use crate::seal::Seal;
use crate::{auth, Ctx, Outbound, Outgoing};

/// The most one message may be; node's ws holds the same ceiling, and the pre-auth cap sits far under it.
const MESSAGE_MAX_BYTES: usize = 100 * 1024 * 1024;
/// How long a refused peer gets to answer the close frame before the stream is dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(5);
/// A socket with no quiet cut: the sleep it never reaches.
const FOREVER: Duration = Duration::from_secs(60 * 60 * 24 * 365);
/// The most of a request head that is read ahead of the framing before the rest is left to it.
const HEAD_MAX_BYTES: usize = 16 * 1024;
/// What a plain HTTP request is answered with: the one status the host's probe reads as a daemon, since nothing
/// else on a machine answers it, as node's ws server answered it before.
const UPGRADE_REQUIRED: &[u8] = b"HTTP/1.1 426 Upgrade Required\r\nUpgrade: websocket\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/// Bytes read since the handshake and whether they crossed the cap, shared by the stream that counts inside its
/// read and the task that acts on the trip.
#[derive(Default)]
struct PreAuth {
    read: AtomicU64,
    baseline: AtomicU64,
    armed: AtomicBool,
    tripped: AtomicBool,
}

impl PreAuth {
    fn arm(&self) {
        self.baseline.store(self.read.load(Ordering::Relaxed), Ordering::Relaxed);
        self.armed.store(true, Ordering::Relaxed);
    }

    fn disarm(&self) {
        self.armed.store(false, Ordering::Relaxed);
    }

    fn tripped(&self) -> bool {
        self.tripped.load(Ordering::Relaxed)
    }
}

/// The TCP stream with its read side counted, handing back first the request head read ahead of the framing.
struct Counted {
    inner: TcpStream,
    pre: Arc<PreAuth>,
    ahead: Vec<u8>,
    ahead_at: usize,
}

impl AsyncRead for Counted {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.ahead_at < this.ahead.len() {
            let n = buf.remaining().min(this.ahead.len() - this.ahead_at);
            buf.put_slice(&this.ahead[this.ahead_at..this.ahead_at + n]);
            this.ahead_at += n;
            return Poll::Ready(Ok(()));
        }
        let before = buf.filled().len();
        let polled = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &polled {
            let n = (buf.filled().len() - before) as u64;
            let total = this.pre.read.fetch_add(n, Ordering::Relaxed) + n;
            if this.pre.armed.load(Ordering::Relaxed) && total - this.pre.baseline.load(Ordering::Relaxed) > numbers::PRE_AUTH_MAX_BYTES {
                this.pre.tripped.store(true, Ordering::Relaxed);
                this.pre.disarm();
                return Poll::Ready(Err(io::Error::other(words::AUTH_TOO_MANY_BYTES)));
            }
        }
        polled
    }
}

impl AsyncWrite for Counted {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

type Socket = WebSocketStream<Counted>;

fn text(value: &impl serde::Serialize) -> Message {
    Message::text(serde_json::to_string(value).expect("a frame serialises"))
}

/// The request head up to its blank line, or as much of it as the cap allows; nothing when the peer went first.
async fn read_head(tcp: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    while !head.ends_with(b"\r\n\r\n") && !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < HEAD_MAX_BYTES {
        let n = tcp.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        head.extend_from_slice(&chunk[..n]);
    }
    Ok(head)
}

/// Whether a request head asks for the WebSocket upgrade: the one header the framing insists on, read the way it
/// reads it, so a request that would fail the handshake is answered instead of dropped.
fn asks_for_upgrade(head: &[u8]) -> bool {
    String::from_utf8_lossy(head).lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else { return false };
        name.trim().eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
    })
}

/// One socket, start to end: the handshake and the auth frame under the deadline, then the op loop. A plain HTTP
/// request, which the host's status probe sends, is answered 426 and closed: that answer is how a probe tells a
/// daemon from an edge speaking for a machine that has none.
pub(crate) async fn serve(mut tcp: TcpStream, ctx: Arc<Ctx>) {
    let deadline = Instant::now() + ctx.auth_deadline;
    let Ok(Ok(head)) = timeout_at(deadline, read_head(&mut tcp)).await else {
        return;
    };
    if !asks_for_upgrade(&head) {
        let _ = tcp.write_all(UPGRADE_REQUIRED).await;
        let _ = tcp.shutdown().await;
        return;
    }
    let pre = Arc::new(PreAuth::default());
    let stream = Counted { inner: tcp, pre: Arc::clone(&pre), ahead: head, ahead_at: 0 };
    let config = WebSocketConfig::default().max_message_size(Some(MESSAGE_MAX_BYTES)).max_frame_size(Some(MESSAGE_MAX_BYTES));
    let Ok(Ok(mut ws)) = timeout_at(deadline, tokio_tungstenite::accept_async_with_config(stream, Some(config))).await else {
        return;
    };
    pre.arm();
    let first = loop {
        match timeout_at(deadline, ws.next()).await {
            Err(_) => return refuse(ws, words::AUTH_NO_FRAME_IN_TIME, &pre).await,
            Ok(Some(Ok(Message::Text(t)))) => break t.to_string(),
            Ok(Some(Ok(Message::Binary(b)))) => break String::from_utf8_lossy(&b).into_owned(),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)))) => continue,
            // A frame announcing more than the message cap is the same peer as one that streams past the byte cap.
            Ok(Some(Err(WsError::Capacity(_)))) => {
                pre.tripped.store(true, Ordering::Relaxed);
                return refuse(ws, words::AUTH_TOO_MANY_BYTES, &pre).await;
            }
            Ok(Some(Err(_))) if pre.tripped() => return refuse(ws, words::AUTH_TOO_MANY_BYTES, &pre).await,
            // The peer closed, or sent a frame the framing refuses: that socket ends and nothing else.
            Ok(_) => return,
        }
    };
    let Ok(auth) = serde_json::from_str::<DaemonAuthRequest>(&first) else {
        return refuse(ws, words::AUTH_FIRST_FRAME, &pre).await;
    };
    if !auth::token_matches(&auth.token, &ctx.options.token_path) {
        return refuse(ws, words::AUTH_TOKEN_REFUSED, &pre).await;
    }
    pre.disarm();
    if ws.send(text(&Reply::new(Some(auth.id), Empty {}))).await.is_err() {
        return;
    }
    let (tx, rx) = mpsc::unbounded_channel();
    // The token this socket came in on is held: a rotation takes the sockets the old one opened, and one let in
    // on the new token in the same breath as the write stays.
    let conn = Arc::new(Conn::new(ctx.next_key(), auth.port, Outbound(tx), Road::Inbound, Some(auth.token)));
    serve_authed(ws, &ctx, conn, rx, None, None).await;
}

/// The door inside one workspace: every socket accepted on that workspace's own unix socket, each served with no
/// auth frame and no token. The file is the gate, and what the socket may ask for is the roads table's, which
/// answers a process inside its own two guest ops and refuses it everything else.
pub(crate) async fn serve_workspace(listener: tokio::net::UnixListener, ctx: Arc<Ctx>, workspace: String) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        let (ctx, workspace) = (Arc::clone(&ctx), workspace.clone());
        tokio::spawn(serve_inside(stream, ctx, workspace));
    }
}

/// One socket inside a workspace: the handshake, then the same loop every authed socket runs. Nothing is checked
/// at this door, since nothing but that workspace can see the file it was opened on; the socket is never added to
/// the authed list, so what the daemon pushes to every authed socket, the URLs it reads off this computer's own
/// ptys among it, reaches nothing inside a workspace.
async fn serve_inside(stream: tokio::net::UnixStream, ctx: Arc<Ctx>, workspace: String) {
    let config = WebSocketConfig::default().max_message_size(Some(MESSAGE_MAX_BYTES)).max_frame_size(Some(MESSAGE_MAX_BYTES));
    let deadline = Instant::now() + ctx.auth_deadline;
    let Ok(Ok(ws)) = timeout_at(deadline, tokio_tungstenite::accept_async_with_config(stream, Some(config))).await else {
        return;
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let conn = Arc::new(Conn::new(ctx.next_key(), None, Outbound(tx), Road::Workspace(workspace), None));
    serve_authed(ws, &ctx, conn, rx, None, None).await;
}

/// How a served socket ended: the peer went, the link carried nothing for the quiet span, or a leave was answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ended {
    Peer,
    Quiet,
    Leave,
    Restart,
    /// The token this socket authed with is no longer the file's.
    Rotated,
}

/// The one loop every authed socket runs, inbound or the link a place opened: the hello first, then each frame
/// answered on its own task, as the node daemon answers them, so a heartbeat is not held behind an exec that runs
/// for a minute. Replies and events share one channel, so what a handler sends stays in order. `quiet` is the
/// link's cut: a socket that carries no frame for that long ends here and the caller redials.
pub(crate) async fn serve_authed<S>(
    mut ws: WebSocketStream<S>,
    ctx: &Arc<Ctx>,
    conn: Arc<Conn>,
    mut rx: mpsc::UnboundedReceiver<Outgoing>,
    quiet: Option<Duration>,
    mut seal: Option<Seal>,
) -> Ended
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let key = conn.key;
    if conn.scope.is_none() && !matches!(conn.road, Road::Workspace(_)) {
        ctx.add_authed(key, conn.out.clone());
    }
    if let Some(token) = conn.token.clone() {
        ctx.add_tokened(key, token, conn.out.clone());
    }
    let hello = DaemonEvent::DaemonHello { root: ctx.root.clone(), version: Some(numbers::DAEMON_VERSION) };
    let mut ended = Ended::Peer;
    if emit(&mut ws, &mut seal, crate::frame_text(&hello)).await {
        let idle = tokio::time::sleep(quiet.unwrap_or(FOREVER));
        tokio::pin!(idle);
        ended = loop {
            tokio::select! {
                incoming = ws.next() => {
                    let raw = match incoming {
                        // On a sealed link nothing arrives in the clear: a text frame after the prove is a
                        // carrier writing into the link, and the socket ends rather than reading it.
                        Some(Ok(Message::Text(t))) if seal.is_none() => t.to_string(),
                        Some(Ok(Message::Binary(b))) => match seal.as_mut() {
                            Some(seal) => match seal.unseal(&b) {
                                Some(text) => text,
                                None => break Ended::Peer,
                            },
                            None => String::from_utf8_lossy(&b).into_owned(),
                        },
                        Some(Ok(Message::Text(_))) => break Ended::Peer,
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break Ended::Peer,
                        Some(Ok(_)) => continue,
                    };
                    if let Some(span) = quiet {
                        idle.as_mut().reset(Instant::now() + span);
                    }
                    let (conn, ctx) = (Arc::clone(&conn), Arc::clone(ctx));
                    tokio::spawn(async move {
                        let reply = ops::handle(&conn, &ctx, &raw).await;
                        conn.out.send(reply);
                    });
                }
                outgoing = rx.recv() => {
                    match outgoing {
                        None => break Ended::Peer,
                        Some(Outgoing::Text(t)) => {
                            if !emit(&mut ws, &mut seal, t).await {
                                break Ended::Peer;
                            }
                        }
                        // A guest frame gives its workspace's bytes back once it is out of this socket: until then
                        // it is waiting here, and what waits is what the cap counts.
                        Some(Outgoing::Guest(t, held)) => {
                            let wrote = emit(&mut ws, &mut seal, t).await;
                            drop(held);
                            if !wrote {
                                break Ended::Peer;
                            }
                        }
                        // The reply goes out whole before the daemon stops: the host reads what was swept, or where
                        // the binary it sent landed.
                        Some(Outgoing::Leave(t)) => {
                            emit(&mut ws, &mut seal, t).await;
                            let _ = ws.flush().await;
                            break Ended::Leave;
                        }
                        Some(Outgoing::Restart(t)) => {
                            emit(&mut ws, &mut seal, t).await;
                            let _ = ws.flush().await;
                            break Ended::Restart;
                        }
                        // Nothing is written to a socket whose token the file no longer holds: it is closed with
                        // the sentence and no frame, as every socket the door itself turns away is.
                        Some(Outgoing::Rotated) => break Ended::Rotated,
                    }
                }
                _ = &mut idle, if quiet.is_some() => break Ended::Quiet,
            }
        };
    }
    // The client is gone; the ptys and the watchers keep running. Only this socket's subscriptions and tunnels die
    // with it.
    ctx.remove_authed(key);
    ctx.guests.socket_closed(key);
    conn.close();
    let closing = match ended {
        Ended::Peer => None,
        Ended::Quiet => Some((CloseCode::Normal, words::LINK_CLOSE_QUIET)),
        Ended::Leave => Some((CloseCode::Normal, words::LINK_CLOSE_STOPPING)),
        Ended::Restart => Some((CloseCode::Normal, words::LINK_CLOSE_UPDATING)),
        // Under the code every socket this daemon turns away for its token travels with, so a client reads a
        // rotation the way it reads a token refused at the door.
        Ended::Rotated => Some((CloseCode::from(words::AUTH_CLOSE_CODE), words::AUTH_TOKEN_ROTATED)),
    };
    let frame = closing.map(|(code, reason)| CloseFrame { code, reason: reason.into() });
    let _ = timeout(CLOSE_WAIT, ws.close(frame)).await;
    // Both endings stop this process. What differs is what happens next on that computer: after a leave nothing
    // brings it back, and after an update its supervisor starts the binary that landed.
    if ended == Ended::Leave || ended == Ended::Restart {
        ctx.stop.notify_one();
    }
    ended
}

/// Every frame this socket sends leaves through here: sealed where the link agreed a key, text where it did not.
/// One door for the hello, the replies off the sink and the leave and the restart alike, so no frame of this
/// daemon's ever leaves a sealed link in the clear. False once the peer is gone.
async fn emit<S>(ws: &mut WebSocketStream<S>, seal: &mut Option<Seal>, text: String) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let message = match seal.as_mut() {
        Some(seal) => Message::Binary(seal.seal(&text).into()),
        None => Message::text(text),
    };
    ws.send(message).await.is_ok()
}

/// Closes 4401 with one sentence, then waits for the peer's close as node's ws does. A peer cut for streaming past
/// the cap is mid-frame, so its next bytes, or its silence past the wait, end the connection outright.
async fn refuse(mut ws: Socket, reason: &str, pre: &PreAuth) {
    pre.disarm();
    let frame = CloseFrame { code: CloseCode::from(words::AUTH_CLOSE_CODE), reason: reason.into() };
    if ws.send(Message::Close(Some(frame))).await.is_err() {
        return;
    }
    let drain = async {
        if pre.tripped() {
            let mut buf = [0u8; 1024];
            let _ = ws.get_mut().inner.read(&mut buf).await;
        } else {
            while let Some(Ok(_)) = ws.next().await {}
        }
    };
    let _ = timeout(CLOSE_WAIT, drain).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Options;
    use serde_json::{json, Value};
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixStream;

    const WAIT: Duration = Duration::from_secs(5);

    /// The next text frame, or nothing within the wait.
    async fn frame(ws: &mut WebSocketStream<UnixStream>) -> Option<Value> {
        match timeout(WAIT, ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str(&t).ok(),
            _ => None,
        }
    }

    /// A socket inside a workspace: the door takes it with no auth frame, answers the hello, serves the guest's
    /// own ops, and is not one of the sockets the daemon pushes to. What the roads table refuses there is proved
    /// in the switch's own cases; what is proved here is the door.
    #[tokio::test]
    async fn a_workspace_door_serves_a_socket_that_sent_no_auth_frame_and_hears_nothing_broadcast() {
        let mut token = tempfile::NamedTempFile::new().unwrap();
        writeln!(token, "t").unwrap();
        let home = tempfile::tempdir().unwrap();
        let mut options = Options::new(token.path());
        options.root = Some(home.path().to_path_buf());
        options.manifest_path = Some(home.path().join("manifest.json"));
        let ctx = Arc::new(Ctx::new(options, Box::new(|_| {})).unwrap());
        let at = home.path().join("daemon.sock");
        ctx.open_workspace_door("wsp-a", &at);
        assert_eq!(std::fs::metadata(&at).unwrap().permissions().mode() & 0o777, 0o600);

        let (mut ws, _) = tokio_tungstenite::client_async("ws://workspace/", UnixStream::connect(&at).await.unwrap()).await.unwrap();
        let hello = frame(&mut ws).await.expect("the door says hello with no auth frame");
        assert_eq!(hello["type"], "daemon.hello");
        ws.send(Message::text(json!({"id": 1, "op": "guest.open", "kind": "cli", "token": "t", "argv": [], "cwd": "/root"}).to_string()))
            .await
            .unwrap();
        let opened = frame(&mut ws).await.unwrap();
        assert_eq!(opened["ok"], json!(true), "{opened}");

        // A socket of the computer's own hears what the daemon pushes to every authed socket; the one inside a
        // workspace hears none of it, since the URLs read off this computer's ptys are not that workspace's.
        let (tx, mut authed) = mpsc::unbounded_channel();
        ctx.add_authed(ctx.next_key(), crate::Outbound(tx));
        ctx.broadcast(&DaemonEvent::LocalhostUrl { port: wsp_frames::RelayPort::new(8123).unwrap() });
        let heard = timeout(WAIT, authed.recv()).await.unwrap().unwrap();
        assert_eq!(serde_json::from_str::<Value>(heard.text()).unwrap()["type"], "localhost.url");
        assert!(timeout(Duration::from_millis(200), ws.next()).await.is_err(), "a socket inside a workspace was pushed to");

        // And the door goes with the workspace: the loop ends, so a dial finds nothing to answer it. The file it
        // was bound on is the workspace's own folder's and the runtime takes it off with the workspace, since a
        // workspace may be stopped by something other than the daemon that bound this.
        ctx.close_workspace_door("wsp-a");
        let refused = async {
            while UnixStream::connect(&at).await.is_ok() {
                tokio::task::yield_now().await;
            }
        };
        assert!(timeout(WAIT, refused).await.is_ok(), "the door still answers after the workspace stopped");
    }
}
