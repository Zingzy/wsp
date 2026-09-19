// SPDX-License-Identifier: AGPL-3.0-only
//! The tool server kind: this process is the stdio a harness speaks JSON-RPC over, and every line either way is one
//! message on the session. Nothing here reads a message; the harness on one end and the host's own server on the
//! other are what give them meaning.

use futures_util::SinkExt;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

use crate::{closed, message, next_frame, Socket, Streams};

pub(crate) async fn pump<S: AsyncRead + AsyncWrite + Unpin>(mut ws: Socket<S>, streams: &mut Streams<'_>) -> i32 {
    // Bytes read but not yet a whole line. The read is fill_buf and not read_line because this waits on the socket
    // at the same time, and a read_line a frame cancels loses whatever half line it had taken.
    let mut held: Vec<u8> = Vec::new();
    let mut id = 3;
    loop {
        tokio::select! {
            read = streams.input.fill_buf() => {
                // The harness closed its end, or its stdin broke: the session goes with it.
                let taken = match read {
                    Ok(chunk) if !chunk.is_empty() => {
                        held.extend_from_slice(chunk);
                        chunk.len()
                    }
                    _ => return 0,
                };
                streams.input.consume(taken);
                while let Some(at) = held.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = held.drain(..=at).collect();
                    let Ok(sent) = serde_json::from_slice::<Value>(&line) else { continue };
                    id += 1;
                    if ws.send(Message::text(json!({ "id": id, "op": "guest.send", "message": sent }).to_string())).await.is_err() {
                        return 1;
                    }
                }
            }
            frame = next_frame(&mut ws) => {
                let Some(frame) = frame else { return 1 };
                if let Some(code) = closed(&frame, streams).await {
                    return code;
                }
                // A send the wire refused (a message past the cap) is a reply and not an event: the harness gets no
                // answer to that one request, and the person reading the thread gets the reason.
                if frame.get("ok") == Some(&serde_json::Value::Bool(false)) {
                    let said = frame.get("error").and_then(|e| e.as_str()).unwrap_or("the message was refused").to_owned();
                    let _ = streams.err.write_all(format!("{said}\n").as_bytes()).await;
                    let _ = streams.err.flush().await;
                    continue;
                }
                let Some(message) = message(&frame) else { continue };
                // One message, one line, as a stdio transport reads them.
                let written = format!("{message}\n");
                if streams.out.write_all(written.as_bytes()).await.is_err() || streams.out.flush().await.is_err() {
                    return 1;
                }
            }
        }
    }
}
