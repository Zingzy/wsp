// SPDX-License-Identifier: AGPL-3.0-only
//! One socket to the host, as the command line's dial holds it: the token rides in the first frame and never in the
//! address, then each request carries an id its reply comes back under; a frame that answers no request goes to every
//! listener open at the time, the events a turn or an exec pushes. The socket opening and the answer to the token
//! share one deadline, so a port that accepts and never answers fails in one line. When the socket goes, every
//! request still waiting fails with the words for how it went: the host letting it go as it stopped, or the host
//! gone. packages/host/src/verbs.ts `dialOnce` is the rule. A host somewhere else first proves the key this computer
//! pinned for it at `seal.open`, and every frame after that reply rides inside the seal both ends agreed, so the token
//! and everything the line asks for cross a road whose carrier reads nothing and writes nothing into it.

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
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use wsp_frames::{
    numbers, place_link_transcript, Base64Bytes, LinkEphemerals, LinkRole, PlaceEphemeral, PlaceNonce, PlacePublicKey, PlaceSignature,
};
use wsp_seal::Seal;

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
    /// Set once the host proved the pinned key: from then on every frame either way is sealed, and one in the clear
    /// or one that will not open ends the socket.
    seal: Mutex<Option<Seal>>,
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

/// What a dial presents once any seal is open: the token this computer holds, or its device key for a host on the
/// account that has handed it none yet.
pub enum Presents<'a> {
    Token(&'a str),
    Admit(&'a Admit),
}

/// A computer the account admitted: the key that host was told to trust, and what its listing calls this computer.
pub struct Admit {
    pub name: String,
    pub public_key: String,
    pub private_key_pem: String,
}

/// The device token a host answered an admission with.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub device_id: String,
    pub device_token: String,
}

/// Why a dial ended, and whether it was the answer to the frame that carried the token or the admission: the one
/// refusal a second dial can do anything about, since a host that never proved the pinned key refuses the same way
/// however often it is asked.
pub struct Refused {
    pub failure: Failure,
    pub token: bool,
}

/// Where a dial goes and what it holds the host to: the socket's url, the address as the person reads it, the time
/// open and the first answer share, the fingerprint of the key the host must prove, and the alias a host on the
/// account is held under, whose refusal of the token means this computer was taken away.
pub struct Dial<'a> {
    pub url: &'a str,
    pub at: &'a str,
    pub window: Duration,
    pub pinned: Option<&'a str>,
    pub alias: Option<&'a str>,
}

/// The host's answer to seal.open: the key it proves, its nonce, its half of the agreement and its signature.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealOpened {
    nonce: PlaceNonce,
    host_public_key: PlacePublicKey,
    signature: PlaceSignature,
    ephemeral: PlaceEphemeral,
}

/// Dials the host and presents what `presents` names, after the host proved the pinned key where one is pinned.
pub async fn dial(to: &Dial<'_>, presents: Presents<'_>) -> Result<(Client, Option<Paired>), Refused> {
    let words = record::words();
    let at = to.at;
    let not_proved = || Refused { failure: Failure::auth(fill(&words.pair_key, &[("url", at)])), token: false };
    let authed = async {
        let (ws, _) = tokio_tungstenite::connect_async(to.url).await.map_err(|e| Refused {
            failure: Failure::of_kind(fill(&words.no_answer, &[("where", at), ("why", &e.to_string())]), "unreachable"),
            token: false,
        })?;
        let client = Client::over(ws);
        // Before the token or the key: a host on this computer is reached over its own loopback and pins nothing.
        let expect = match to.pinned {
            Some(pinned) => Some(client.open_seal(pinned).await.ok_or_else(not_proved)?),
            None => None,
        };
        let admit = matches!(presents, Presents::Admit(_));
        let answered = match presents {
            Presents::Token(token) => {
                let mut params = Map::new();
                params.insert("token".to_owned(), Value::from(token));
                client.request::<Value>("auth", params).await.map(|_| None)
            }
            Presents::Admit(key) => {
                // The key is proved over this socket's own handshake, so the signature stands for this dial alone.
                let Some(expect) = expect else { return Err(not_proved()) };
                let signature =
                    wsp_seal::sign(&key.private_key_pem, &expect).map_err(|e| Refused { failure: Failure::new(e), token: false })?;
                let mut params = Map::new();
                params.insert("publicKey".to_owned(), Value::from(key.public_key.as_str()));
                params.insert("name".to_owned(), Value::from(key.name.as_str()));
                params.insert("signature".to_owned(), Value::from(Base64Bytes::<64>::from_bytes(&signature).as_str()));
                client.request::<Paired>("device.auth", params).await.map(Some)
            }
        };
        match answered {
            Ok(paired) => Ok((client, paired)),
            Err(refused) => Err(Refused { failure: client.token_refused(refused, to.alias, admit, at).await, token: true }),
        }
    };
    match tokio::time::timeout(to.window, authed).await {
        Ok(dialled) => dialled,
        Err(_) => Err(Refused {
            failure: Failure::of_kind(
                fill(&words.no_answer_within, &[("where", at), ("ms", &to.window.as_millis().to_string())]),
                "unreachable",
            ),
            token: false,
        }),
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
            seal: Mutex::new(None),
            gone: watch::channel(None).0,
        });
        let closer = send.clone();
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
                let text = match read {
                    Ok(Message::Text(text)) if reading.seal.lock().unwrap().is_none() => Ok(text.to_string()),
                    Ok(Message::Text(_)) => Err(()),
                    Ok(Message::Binary(bytes)) => match reading.seal.lock().unwrap().as_mut() {
                        Some(seal) => seal.unseal(&bytes).ok_or(()),
                        None => Ok(String::from_utf8_lossy(&bytes).into_owned()),
                    },
                    Ok(Message::Close(frame)) => {
                        code = frame.map(|f| u16::from(f.code));
                        break;
                    }
                    Ok(_) => continue,
                    Err(_) => break,
                };
                match text {
                    Ok(text) => reading.take(&text),
                    // A frame in the clear after the seal began and one that will not open are the same thing:
                    // somebody carrying the bytes writing into the socket. It ends, and every waiting reply with it.
                    Err(()) => {
                        let refusal = CloseFrame { code: CloseCode::Protocol, reason: record::host().seal_refusal.into() };
                        let _ = closer.send(Message::Close(Some(refusal)));
                        code = Some(u16::from(CloseCode::Protocol));
                        break;
                    }
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
        let text = Value::Object(frame).to_string();
        {
            // Sealed and queued under one lock, so the frames reach the wire in the order their counters were taken.
            let mut seal = self.shared.seal.lock().unwrap();
            let message = match seal.as_mut() {
                Some(seal) => Message::Binary(seal.seal(&text).into()),
                None => Message::text(text),
            };
            let _ = self.send.send(message);
        }
        let text = settled.await.unwrap_or_else(|_| Err(Failure::new(self.close_words())))?;
        let head: Head = serde_json::from_str(&text).map_err(|e| Failure::new(e.to_string()))?;
        if head.ok != Some(true) {
            let said = head.error.as_ref().and_then(Value::as_str).map_or_else(|| format!("{op} failed"), str::to_owned);
            return Err(Failure { message: said, kind: head.kind.as_ref().and_then(Value::as_str).map(str::to_owned) });
        }
        serde_json::from_str(&text).map_err(|e| Failure::new(format!("{op}: {e}")))
    }

    /// The first frame of a dial that pins a key: this computer's nonce and its half of a fresh key agreement,
    /// answered by the host with the key it proves. The fingerprint is read before the signature, since anything
    /// answering at this address signs for itself perfectly well; both stand before a token or a key has crossed.
    /// Answers the bytes the host expects this end to sign for an admission, or none where it proved nothing, which
    /// is one refusal whichever check caught it.
    async fn open_seal(&self, pinned: &str) -> Option<Vec<u8>> {
        let word = record::host().seal_client;
        let (private, mine) = wsp_seal::fresh_ephemeral()?;
        let mine: PlaceEphemeral = Base64Bytes::from_bytes(&mine);
        let mut nonce = [0u8; numbers::PLACE_LINK_NONCE_BYTES];
        getrandom::fill(&mut nonce).ok()?;
        let nonce: PlaceNonce = Base64Bytes::from_bytes(&nonce);
        let mut params = Map::new();
        params.insert("nonce".to_owned(), Value::from(nonce.as_str()));
        params.insert("ephemeral".to_owned(), Value::from(mine.as_str()));
        let opened: SealOpened = self.request("seal.open", params).await.ok()?;
        let key = opened.host_public_key.to_bytes();
        if wsp_seal::fingerprint(&key) != pinned {
            return None;
        }
        let asked = LinkEphemerals { challenger: mine.as_str(), answerer: opened.ephemeral.as_str() };
        let host_bytes = place_link_transcript(LinkRole::Host, &word, nonce.as_str(), opened.nonce.as_str(), asked);
        if !wsp_seal::verify(&key, &host_bytes, &opened.signature.to_bytes()) {
            return None;
        }
        let secret = wsp_seal::agree(private, &opened.ephemeral.to_bytes())?;
        *self.shared.seal.lock().unwrap() = Some(Seal::place(&wsp_seal::seal_keys(&secret, &word)));
        let answered = LinkEphemerals { challenger: opened.ephemeral.as_str(), answerer: mine.as_str() };
        Some(place_link_transcript(LinkRole::Place, &word, opened.nonce.as_str(), nonce.as_str(), answered))
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
    async fn token_refused(&self, refused: Failure, alias: Option<&str>, admit: bool, at: &str) -> Failure {
        let host = record::host();
        match refused.kind.as_deref() {
            None => {
                let mut gone = self.shared.gone.subscribe();
                let _ = tokio::time::timeout(Duration::from_millis(host.close_grace_ms), gone.wait_for(Option::is_some)).await;
                if self.shared.gone.borrow().flatten() != Some(host.unauthorized_close) {
                    return refused;
                }
                // An admission refused with no kind behind an unauthorized close: that door does not know the frame.
                if admit {
                    return Failure::auth(fill(&record::words().device_auth_old_host, &[("where", at)]));
                }
            }
            Some("auth") => {}
            Some(_) => return refused,
        }
        // A host that refused an admission said why in its own sentence, and there is no token to pair again for.
        if admit {
            return Failure::auth(refused.message);
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
