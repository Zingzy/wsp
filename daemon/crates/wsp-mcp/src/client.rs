// SPDX-License-Identifier: AGPL-3.0-only
//! One socket to the host, as the command line's dial holds it: the token rides in the first frame and never in the
//! address, then each request carries an id its reply comes back under; a frame that answers no request goes to every
//! listener open at the time, the events a turn or an exec pushes. The socket opening and the answer to the token
//! share one deadline, so a port that accepts and never answers fails in one line. When the socket goes, every
//! request still waiting fails with the words for how it went: the host letting it go as it stopped, or the host
//! gone. packages/host/src/verbs.ts `dialOnce` is the rule; this is its road with no seal, which a host on this
//! computer or on its loopback takes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::failure::Failure;
use crate::record::{self, fill};

type Waiting = HashMap<u64, oneshot::Sender<Result<String, Failure>>>;

/// The reply's own fields, read before its body is: whether it is a reply, and whether the host said yes.
#[derive(Deserialize)]
struct Head {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    kind: Option<Value>,
}

struct Shared {
    waiting: Mutex<Waiting>,
    /// Each open `Frames` by the number it was handed, taken out when it is dropped.
    listeners: Mutex<Vec<(u64, mpsc::UnboundedSender<String>)>>,
    heard: AtomicU64,
    /// Empty while the socket is open; the close code the host sent, or none, once it is gone.
    gone: watch::Sender<Option<Option<u16>>>,
}

pub struct Client {
    send: mpsc::UnboundedSender<Message>,
    shared: Arc<Shared>,
    next: AtomicU64,
    subscribed: tokio::sync::OnceCell<Result<(), Failure>>,
    tasks: [JoinHandle<()>; 2],
}

/// The frames the host pushes from the moment this was opened, held until read: a reply that names what to follow
/// may land with the first of its frames right behind it. None once the socket is gone.
pub struct Frames {
    told: mpsc::UnboundedReceiver<String>,
    id: u64,
    shared: Arc<Shared>,
}

impl Frames {
    pub async fn next(&mut self) -> Option<String> {
        self.told.recv().await
    }

    /// The next frame already here, without waiting for one.
    pub fn try_next(&mut self) -> Option<String> {
        self.told.try_recv().ok()
    }
}

impl Drop for Frames {
    fn drop(&mut self) {
        self.shared.listeners.lock().unwrap().retain(|(id, _)| *id != self.id);
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Dials the host at `url` and presents `token`; `at` is the host's address as the person reads it, and `alias` the
/// name a host on the account is held under, whose refusal of the token means this computer was taken away.
pub async fn dial(url: &str, token: &str, at: &str, window: Duration, alias: Option<&str>) -> Result<Client, Failure> {
    let words = record::words();
    let authed = async {
        let (ws, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| Failure::of_kind(fill(&words.no_answer, &[("where", at), ("why", &e.to_string())]), "unreachable"))?;
        let client = Client::over(ws);
        let mut params = Map::new();
        params.insert("token".to_owned(), Value::from(token));
        match client.request::<Value>("auth", params).await {
            Ok(_) => Ok(client),
            Err(refused) => Err(client.token_refused(refused, alias).await),
        }
    };
    match tokio::time::timeout(window, authed).await {
        Ok(dialled) => dialled,
        Err(_) => {
            Err(Failure::of_kind(fill(&words.no_answer_within, &[("where", at), ("ms", &window.as_millis().to_string())]), "unreachable"))
        }
    }
}

impl Client {
    fn over<S>(ws: tokio_tungstenite::WebSocketStream<S>) -> Client
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (mut sink, mut stream) = ws.split();
        let (send, mut outgoing) = mpsc::unbounded_channel::<Message>();
        let shared = Arc::new(Shared {
            waiting: Mutex::new(HashMap::new()),
            listeners: Mutex::new(Vec::new()),
            heard: AtomicU64::new(0),
            gone: watch::channel(None).0,
        });
        let writer = tokio::spawn(async move {
            while let Some(message) = outgoing.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });
        let reading = shared.clone();
        let reader = tokio::spawn(async move {
            let mut code = None;
            while let Some(read) = stream.next().await {
                match read {
                    Ok(Message::Text(text)) => reading.take(text.as_str()),
                    Ok(Message::Close(frame)) => {
                        code = frame.map(|f| u16::from(f.code));
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            reading.went(code);
        });
        Client { send, shared, next: AtomicU64::new(1), subscribed: tokio::sync::OnceCell::new(), tasks: [writer, reader] }
    }

    /// Every frame that answers no request from now on.
    pub fn frames(&self) -> Frames {
        let (tell, told) = mpsc::unbounded_channel();
        let id = self.shared.heard.fetch_add(1, Ordering::Relaxed);
        let mut listeners = self.shared.listeners.lock().unwrap();
        if self.shared.gone.borrow().is_none() {
            listeners.push((id, tell));
        }
        Frames { told, id, shared: self.shared.clone() }
    }

    /// The host's events on this socket, asked for once however many calls follow them.
    pub async fn events(&self) -> Result<(), Failure> {
        self.subscribed.get_or_init(|| async { self.request::<Value>("events.subscribe", Map::new()).await.map(|_| ()) }).await.clone()
    }

    /// Whether the host let this socket go as it stopped, which a wait dials through; read once the socket is gone.
    pub fn stopped_under(&self) -> bool {
        self.shared.gone.borrow().flatten() == Some(record::host().stopping_close)
    }

    /// Once the socket is gone, however it went.
    pub async fn closed(&self) {
        let mut gone = self.shared.gone.subscribe();
        let _ = gone.wait_for(Option::is_some).await;
    }

    /// One op and its reply, the reply's body read as `T`. A reply that is not ok is its own sentence, or the op's
    /// name where it carried none, with the kind the host stamped on it.
    pub async fn request<T: DeserializeOwned>(&self, op: &str, params: Map<String, Value>) -> Result<T, Failure> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (settle, settled) = oneshot::channel();
        self.shared.waiting.lock().unwrap().insert(id, settle);
        if self.shared.gone.borrow().is_some() {
            self.shared.waiting.lock().unwrap().remove(&id);
            return Err(Failure::new(self.close_words()));
        }
        let mut frame = params;
        frame.insert("id".to_owned(), Value::from(id));
        frame.insert("op".to_owned(), Value::from(op));
        let _ = self.send.send(Message::text(Value::Object(frame).to_string()));
        let text = settled.await.unwrap_or_else(|_| Err(Failure::new(self.close_words())))?;
        let head: Head = serde_json::from_str(&text).map_err(|e| Failure::new(e.to_string()))?;
        if head.ok != Some(true) {
            let said = head.error.as_ref().and_then(Value::as_str).map_or_else(|| format!("{op} failed"), str::to_owned);
            return Err(Failure { message: said, kind: head.kind.as_ref().and_then(Value::as_str).map(str::to_owned) });
        }
        serde_json::from_str(&text).map_err(|e| Failure::new(format!("{op}: {e}")))
    }

    pub fn is_closed(&self) -> bool {
        self.shared.gone.borrow().is_some()
    }

    /// Why the socket is gone, in the words the person reads: a host that let it go as it stopped says the turn goes
    /// on, since the run is the machine's; anything else is a host that went.
    pub fn close_words(&self) -> String {
        close_words(self.shared.gone.borrow().flatten())
    }

    /// What a refusal of the token means to the person. One whose frame carries no kind is classed by the close code
    /// that follows it, so an older host that sends the code alone still reads as auth.
    async fn token_refused(&self, refused: Failure, alias: Option<&str>) -> Failure {
        let host = record::host();
        match refused.kind.as_deref() {
            None => {
                let mut gone = self.shared.gone.subscribe();
                let _ = tokio::time::timeout(Duration::from_millis(host.close_grace_ms), gone.wait_for(Option::is_some)).await;
                if self.shared.gone.borrow().flatten() != Some(host.unauthorized_close) {
                    return refused;
                }
            }
            Some("auth") => {}
            Some(_) => return refused,
        }
        match alias {
            Some(alias) => Failure::auth(fill(&record::words().device_refused, &[("alias", alias)])),
            None => Failure::auth(refused.message),
        }
    }
}

fn close_words(code: Option<u16>) -> String {
    let words = record::words();
    if code == Some(record::host().stopping_close) {
        words.host_stopping
    } else {
        words.host_closed
    }
}

impl Shared {
    fn take(&self, text: &str) {
        let id = serde_json::from_str::<Head>(text).ok().and_then(|head| head.id).and_then(|id| id.as_u64());
        if let Some(waiter) = id.and_then(|id| self.waiting.lock().unwrap().remove(&id)) {
            let _ = waiter.send(Ok(text.to_owned()));
            return;
        }
        for (_, listener) in self.listeners.lock().unwrap().iter() {
            let _ = listener.send(text.to_owned());
        }
    }

    fn went(&self, code: Option<u16>) {
        {
            let mut listeners = self.listeners.lock().unwrap();
            self.gone.send_replace(Some(code));
            listeners.clear();
        }
        let words = close_words(code);
        for (_, waiter) in self.waiting.lock().unwrap().drain() {
            let _ = waiter.send(Err(Failure::new(words.clone())));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_listener_goes_when_its_frames_is_dropped() {
        let (near, far) = tokio::io::duplex(1024);
        let serving = tokio::spawn(async move { tokio_tungstenite::accept_async(far).await.unwrap() });
        let (ws, _) = tokio_tungstenite::client_async("ws://host/ws", near).await.unwrap();
        let _server = serving.await.unwrap();
        let client = Client::over(ws);
        let (kept, dropped) = (client.frames(), client.frames());
        assert_eq!(client.shared.listeners.lock().unwrap().len(), 2);
        drop(dropped);
        let left: Vec<u64> = client.shared.listeners.lock().unwrap().iter().map(|(id, _)| *id).collect();
        assert_eq!(left, [kept.id]);
    }
}
