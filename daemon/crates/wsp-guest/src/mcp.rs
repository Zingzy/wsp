// SPDX-License-Identifier: AGPL-3.0-only
//! The tool server kind: this process is the stdio a harness speaks JSON-RPC over, and every line either way is one
//! message on the session. Nothing here gives a message meaning: the harness on one end and the host's own server on
//! the other do, and the host's messages are written out as the host wrote them.

use std::collections::BTreeMap;

use futures_util::SinkExt;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

use crate::{closed, next_text, Socket, Streams, OPEN_ID};

/// What a tool server session keeps across reads: the bytes of a line not yet whole, and the id the next message on
/// the session goes under.
#[derive(Default)]
pub(crate) struct Carry {
    held: Vec<u8>,
    next_id: u64,
}

impl Carry {
    /// The next whole line the harness wrote, parsed; lines that are not JSON are dropped as a stdio transport drops
    /// them. None once the harness has closed its end.
    pub(crate) async fn next_line(&mut self, streams: &mut Streams<'_>) -> Option<Value> {
        loop {
            if let Some(at) = self.held.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.held.drain(..=at).collect();
                match serde_json::from_slice::<Value>(&line) {
                    Ok(read) => return Some(read),
                    Err(_) => continue,
                }
            }
            let taken = match streams.input.fill_buf().await {
                Ok(chunk) if !chunk.is_empty() => {
                    self.held.extend_from_slice(chunk);
                    chunk.len()
                }
                _ => return None,
            };
            streams.input.consume(taken);
        }
    }

    /// Sends one of the harness's messages on the session; false where the socket would not take it.
    pub(crate) async fn send<S: AsyncRead + AsyncWrite + Unpin>(&mut self, ws: &mut Socket<S>, sent: &Value) -> bool {
        self.next_id += 1;
        let frame = json!({ "id": self.next_id + OPEN_ID, "op": "guest.send", "message": sent });
        ws.send(Message::text(frame.to_string())).await.is_ok()
    }
}

/// How a pump ended: with the code this process exits with, or with the socket gone and the harness still there.
pub(crate) enum End {
    Code(i32),
    Lost,
}

pub(crate) async fn pump<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut Socket<S>, streams: &mut Streams<'_>, carry: &mut Carry) -> End {
    loop {
        tokio::select! {
            // A pending read is cancelled when a frame wins; the half line it took stays in the carry.
            read = carry.next_line(streams) => {
                let Some(sent) = read else { return End::Code(0) };
                if !carry.send(ws, &sent).await {
                    return End::Lost;
                }
            }
            text = next_text(ws) => {
                let Some(text) = text else { return End::Lost };
                let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(code) = closed(&frame, streams).await {
                    return End::Code(code);
                }
                // A send the wire refused (a message past the cap) is a reply and not an event: the harness gets no
                // answer to that one request, and the person reading the thread gets the reason.
                if frame.get("ok") == Some(&Value::Bool(false)) {
                    let said = frame.get("error").and_then(Value::as_str).unwrap_or("the message was refused").to_owned();
                    let _ = streams.err.write_all(format!("{said}\n").as_bytes()).await;
                    let _ = streams.err.flush().await;
                    continue;
                }
                if frame.get("type").and_then(Value::as_str) != Some("guest.message") {
                    continue;
                }
                let Some(raw) = serde_json::from_str::<BTreeMap<String, Box<RawValue>>>(&text).ok().and_then(|mut f| f.remove("message")) else { continue };
                // One message, one line, as a stdio transport reads them, in the bytes the server wrote it in.
                let written = format!("{}\n", raw.get());
                if streams.out.write_all(written.as_bytes()).await.is_err() || streams.out.flush().await.is_err() {
                    return End::Code(1);
                }
            }
        }
    }
}
