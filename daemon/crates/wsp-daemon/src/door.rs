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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{timeout, timeout_at, Instant};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;
use wsp_frames::{numbers, words, DaemonAuthRequest, DaemonEvent, Empty, Reply};

use crate::ops::{self, Conn, Road};
use crate::{auth, Ctx, Outbound, Outgoing};

/// The most one message may be; node's ws holds the same ceiling, and the pre-auth cap sits far under it.
const MESSAGE_MAX_BYTES: usize = 100 * 1024 * 1024;
/// How long a refused peer gets to answer the close frame before the stream is dropped.
const CLOSE_WAIT: Duration = Duration::from_secs(5);
/// A socket with no quiet cut: the sleep it never reaches.
const FOREVER: Duration = Duration::from_secs(60 * 60 * 24 * 365);

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

/// The TCP stream with its read side counted.
struct Counted {
    inner: TcpStream,
    pre: Arc<PreAuth>,
}

impl AsyncRead for Counted {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
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

/// One socket, start to end: the handshake and the auth frame under the deadline, then the op loop.
pub(crate) async fn serve(tcp: TcpStream, ctx: Arc<Ctx>) {
    let pre = Arc::new(PreAuth::default());
    let stream = Counted { inner: tcp, pre: Arc::clone(&pre) };
    let deadline = Instant::now() + ctx.auth_deadline;
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
    let conn = Arc::new(Conn::new(auth.port, Outbound(tx), Road::Inbound));
    serve_authed(ws, &ctx, conn, rx, None).await;
}

/// How a served socket ended: the peer went, the link carried nothing for the quiet span, or a leave was answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ended {
    Peer,
    Quiet,
    Leave,
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
) -> Ended
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let key = ctx.next_key();
    if conn.scope.is_none() {
        ctx.add_authed(key, conn.out.clone());
    }
    let hello = DaemonEvent::DaemonHello { root: ctx.root.clone(), version: Some(numbers::DAEMON_VERSION) };
    let mut ended = Ended::Peer;
    if ws.send(text(&hello)).await.is_ok() {
        let idle = tokio::time::sleep(quiet.unwrap_or(FOREVER));
        tokio::pin!(idle);
        ended = loop {
            tokio::select! {
                incoming = ws.next() => {
                    let raw = match incoming {
                        Some(Ok(Message::Text(t))) => t.to_string(),
                        Some(Ok(Message::Binary(b))) => String::from_utf8_lossy(&b).into_owned(),
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
                            if ws.send(Message::text(t)).await.is_err() {
                                break Ended::Peer;
                            }
                        }
                        // The leave's reply goes out whole before the daemon stops: the host reads what was swept.
                        Some(Outgoing::Leave(t)) => {
                            let _ = ws.send(Message::text(t)).await;
                            let _ = ws.flush().await;
                            break Ended::Leave;
                        }
                    }
                }
                _ = &mut idle, if quiet.is_some() => break Ended::Quiet,
            }
        };
    }
    // The client is gone; ptys keep running. Only this socket's subscriptions die with it.
    ctx.remove_authed(key);
    conn.close();
    let reason = match ended {
        Ended::Peer => None,
        Ended::Quiet => Some(words::LINK_CLOSE_QUIET),
        Ended::Leave => Some(words::LINK_CLOSE_STOPPING),
    };
    let frame = reason.map(|reason| CloseFrame { code: CloseCode::Normal, reason: reason.into() });
    let _ = timeout(CLOSE_WAIT, ws.close(frame)).await;
    if ended == Ended::Leave {
        ctx.stop.notify_one();
    }
    ended
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
