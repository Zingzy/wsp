// SPDX-License-Identifier: AGPL-3.0-only
//! The wsp a process inside a machine runs. It dials no host: it opens one session on its own machine's daemon,
//! over loopback with the daemon's own token, and the daemon carries that session up the socket the host already
//! holds. The thread's token rides inside the session and is read by the host, never here, and nothing in this
//! crate knows a verb: the line goes over whole and the host runs the command line it already has.

mod cli;
mod here;
mod mcp;

pub use here::run_here;

use std::net::SocketAddr;
use std::path::Path;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use wsp_frames::{numbers, words, GuestKind};

/// The socket this session speaks over, whichever road it took: the machine's own loopback port, or the socket
/// the daemon of the computer this workspace sits on put inside it.
pub type Socket<S> = WebSocketStream<S>;

/// What a dial over the workspace's own socket carries: nothing of the sort a URL needs, since a unix socket has
/// no address and the framing wants one all the same.
const INSIDE_URL: &str = "ws://workspace/";

/// What the launch tells a turn about itself: the thread's token, and the turn it is running inside.
const HOST_TOKEN_ENV: &str = "WSP_HOST_TOKEN";
const TURN_TOKEN_ENV: &str = "WSP_TURN";

/// The word that opens a tool server rather than a command line; every other line is one the host's own command
/// line reads.
const MCP_WORD: &str = "mcp";

/// What a session that never reached the host exits with, and what a session the host ended with a reason does.
const REFUSED: i32 = 1;

/// The three streams this process is, handed in rather than taken, so a case drives the client the way a shell
/// does and reads what landed on each one.
pub struct Streams<'a> {
    pub input: &'a mut (dyn AsyncBufRead + Unpin + Send),
    pub out: &'a mut (dyn AsyncWrite + Unpin + Send),
    pub err: &'a mut (dyn AsyncWrite + Unpin + Send),
}

/// Runs one guest line on this process's own streams and answers with the code it should exit.
pub fn run(line: &[String], env: &dyn Fn(&str) -> Option<String>, daemon: SocketAddr, token_path: &Path, socket_path: &Path) -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("{e}");
            return REFUSED;
        }
    };
    let mut input = BufReader::new(tokio::io::stdin());
    let mut out = tokio::io::stdout();
    let mut err = tokio::io::stderr();
    let mut streams = Streams { input: &mut input, out: &mut out, err: &mut err };
    runtime.block_on(session(line, env, daemon, token_path, socket_path, &mut streams))
}

/// Runs one line typed on a computer somebody joined, over the door its daemon binds for that computer's threads.
pub fn run_at_door(line: &[String], env: &dyn Fn(&str) -> Option<String>, door: &Path, unit: Option<&str>) -> i32 {
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("{e}");
            return REFUSED;
        }
    };
    let mut input = BufReader::new(tokio::io::stdin());
    let mut out = tokio::io::stdout();
    let mut err = tokio::io::stderr();
    let mut streams = Streams { input: &mut input, out: &mut out, err: &mut err };
    runtime.block_on(session_at_door(line, env, door, unit, &mut streams))
}

/// One session over that door, start to end. The door is the whole road: that computer's loopback port is anybody's
/// to bind and the token file in wsp's folder there is its daemon's own, which opens a socket that runs anything as
/// root, so a door that is missing or refuses is said in one sentence and nothing else is dialled or read. The unit
/// is the daemon's own, as its shim names it, for the restart that sentence ends with.
pub async fn session_at_door(
    line: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    door: &Path,
    unit: Option<&str>,
    streams: &mut Streams<'_>,
) -> i32 {
    let lost = words::guest_no_door_line(&computer_name(), door, unit);
    let Ok(socket) = UnixStream::connect(door).await else {
        return refused(streams, &lost).await;
    };
    let Ok((ws, _)) = tokio_tungstenite::client_async(INSIDE_URL, socket).await else {
        return refused(streams, &lost).await;
    };
    speak(ws, line, env, &lost, streams).await
}

/// What the computer a line was typed on calls itself, as hostname prints it, for the sentence that names it.
fn computer_name() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "this computer".to_owned())
}

/// One session start to end. `env` is read rather than taken from this process so a case hands in the launch it
/// means, and the cwd is this process's, which is the folder the line was typed in.
pub async fn session(
    line: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    daemon: SocketAddr,
    token_path: &Path,
    socket_path: &Path,
    streams: &mut Streams<'_>,
) -> i32 {
    // One dial rule: inside a workspace on a computer somebody owns the daemon that serves this machine put a
    // socket of this workspace's own here, and the file is the whole of the gate; on a machine wsp forked there
    // is none, and the road is that machine's own loopback port with its token.
    if socket_path.exists() {
        let Ok(inside) = UnixStream::connect(socket_path).await else {
            return refused(streams, &words::guest_no_daemon_line(daemon.port())).await;
        };
        let Ok((ws, _)) = tokio_tungstenite::client_async(INSIDE_URL, inside).await else {
            return refused(streams, &words::guest_no_daemon_line(daemon.port())).await;
        };
        return speak(ws, line, env, &words::guest_no_daemon_line(daemon.port()), streams).await;
    }
    let Some(ws) = dial(daemon, token_path).await else {
        return refused(streams, &words::guest_no_daemon_line(daemon.port())).await;
    };
    speak(ws, line, env, &words::guest_no_daemon_line(daemon.port()), streams).await
}

/// The session itself, once the socket stands: the open frame, its reply, then the pump for the kind of line this
/// is. The same words every road, since a session is a session whichever socket carried it; `lost` is what the road
/// says of a socket that failed before the far end said anything.
async fn speak<S: AsyncRead + AsyncWrite + Unpin>(
    mut ws: Socket<S>,
    line: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    lost: &str,
    streams: &mut Streams<'_>,
) -> i32 {
    let kind = if line == [MCP_WORD] { GuestKind::Mcp } else { GuestKind::Cli };
    if let Err(error) = open(&mut ws, kind, line, env).await {
        let said = error.unwrap_or_else(|| lost.to_owned());
        return refused(streams, &said).await;
    }
    match kind {
        GuestKind::Mcp => match mcp::pump(&mut ws, streams, &mut mcp::Carry::default()).await {
            mcp::End::Code(code) => code,
            mcp::End::Lost => REFUSED,
        },
        GuestKind::Cli => cli::pump(ws, streams).await,
    }
}

/// Sends the open frame and reads its reply. The error is the far end's own sentence where it refused the line,
/// and nothing where the socket failed before it could say one, which each road words for itself.
pub(crate) async fn open<S: AsyncRead + AsyncWrite + Unpin>(
    ws: &mut Socket<S>,
    kind: GuestKind,
    line: &[String],
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<(), Option<String>> {
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let mut open = json!({
        "id": OPEN_ID,
        "op": "guest.open",
        "kind": kind,
        // A launch that carried no token opens with none and is refused by the host in its own words, which is the
        // one place that rule is written.
        "token": env(HOST_TOKEN_ENV).unwrap_or_default(),
        "argv": line,
        "cwd": cut(&cwd, numbers::GUEST_CWD_MAX),
    });
    if let Some(turn) = env(TURN_TOKEN_ENV).filter(|t| !t.is_empty()) {
        open["turnToken"] = Value::String(turn);
    }
    if ws.send(Message::text(open.to_string())).await.is_err() {
        return Err(None);
    }
    // The open is answered before anything is pumped: a line the wire refuses (too many words, a token past its cap)
    // comes back as a reply and not an event, and a pump waiting on events alone would wait for good.
    match opened(ws).await {
        None => Ok(()),
        Some(error) => Err(Some(error)),
    }
}

/// The reply to the open, read past the hello that lands with it: the refusal's own sentence when the daemon would
/// not take the line, nothing when the session is open. A socket that ends here answers as a daemon that is gone.
const OPEN_ID: u64 = 2;

async fn opened<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut Socket<S>) -> Option<String> {
    loop {
        let Some(frame) = next_frame(ws).await else { return Some(SOCKET_ENDED.to_owned()) };
        if frame.get("id").and_then(Value::as_u64) != Some(OPEN_ID) {
            continue;
        }
        if frame.get("ok") == Some(&Value::Bool(true)) {
            return None;
        }
        return Some(frame.get("error").and_then(Value::as_str).unwrap_or(SOCKET_ENDED).to_owned());
    }
}

/// What a socket that ended before it answered is said to be; the daemon is there and this session is not.
const SOCKET_ENDED: &str = "this machine's wsp daemon ended the connection";

/// The socket, authed with the daemon's own token off its file; nothing when the daemon is not there or would not
/// take the token, which the caller says in one sentence.
async fn dial(daemon: SocketAddr, token_path: &Path) -> Option<Socket<MaybeTlsStream<TcpStream>>> {
    let token = std::fs::read_to_string(token_path).ok()?;
    authed(&format!("ws://{daemon}/"), token.trim()).await
}

/// A socket at that address with the token as its first frame, once the far end has taken it.
pub(crate) async fn authed(url: &str, token: &str) -> Option<Socket<MaybeTlsStream<TcpStream>>> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.ok()?;
    let auth = json!({ "id": 1, "op": "auth", "token": token });
    ws.send(Message::text(auth.to_string())).await.ok()?;
    let reply = next_frame(&mut ws).await?;
    (reply.get("ok") == Some(&Value::Bool(true))).then_some(ws)
}

/// The next text frame as JSON; nothing once the socket is done.
pub(crate) async fn next_frame<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut Socket<S>) -> Option<Value> {
    serde_json::from_str(&next_text(ws).await?).ok()
}

/// The next frame's text as it came, for a reader that hands part of it on untouched.
pub(crate) async fn next_text<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut Socket<S>) -> Option<String> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => return Some(t.as_str().to_owned()),
            Some(Ok(Message::Binary(b))) => return String::from_utf8(b.to_vec()).ok(),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return None,
        }
    }
}

/// How a session ends whichever kind it was: 0 for an end with no reason, and the host's own sentence on stderr
/// with 1 for one that carried it.
pub(crate) async fn closed(frame: &Value, streams: &mut Streams<'_>) -> Option<i32> {
    if frame.get("type") != Some(&Value::String("guest.closed".to_owned())) {
        return None;
    }
    match frame.get("error").and_then(Value::as_str) {
        None => Some(0),
        Some(error) => Some(refused(streams, error).await),
    }
}

/// One line on stderr and the refused code, which is every way a session ends that the person has to read.
pub(crate) async fn refused(streams: &mut Streams<'_>, line: &str) -> i32 {
    let _ = streams.err.write_all(format!("{line}\n").as_bytes()).await;
    let _ = streams.err.flush().await;
    REFUSED
}

/// The message on a guest.message frame, for the frames this side reads; nothing for anything else.
pub(crate) fn message(frame: &Value) -> Option<&Value> {
    (frame.get("type") == Some(&Value::String("guest.message".to_owned()))).then(|| frame.get("message"))?
}

/// The last characters of an over-long folder, since the wire refuses one past the cap and the end is the part
/// that names where the line was typed.
fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    text.chars().skip(text.chars().count() - max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A computer's door gone while the wsp beside it stands: the line is refused in one sentence naming that
    /// computer, and the loopback port a fork's wsp dials gets nothing, though a listener holds it and the daemon's
    /// token file sits where a fork's wsp reads its own.
    #[tokio::test]
    async fn a_line_at_a_computer_door_that_is_gone_is_refused_and_dials_no_port() {
        let home = tempfile::tempdir().unwrap();
        let at = wsp_frames::place_daemon_paths(home.path());
        std::fs::create_dir_all(&at.guest_bin).unwrap();
        std::fs::write(&at.token_path, "the-box-daemons-own-token").unwrap();
        let squatter = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let home_word = home.path().to_string_lossy().into_owned();
        let env = |name: &str| match name {
            "HOME" => Some(home_word.clone()),
            "WSP_HOST_TOKEN" => Some("thread-token".to_owned()),
            _ => None,
        };
        let mut input = BufReader::new(tokio::io::empty());
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut streams = Streams { input: &mut input, out: &mut out, err: &mut err };
        let unit = Some("wsp-place-ecffdb75.service");
        let code = session_at_door(&["mcp".to_owned()], &env, &at.guest_socket, unit, &mut streams).await;
        assert_eq!(code, REFUSED);
        let said = String::from_utf8(err).unwrap();
        assert_eq!(said, format!("{}\n", words::guest_no_door_line(&computer_name(), &at.guest_socket, unit)));
        assert!(said.ends_with("; restart wsp's daemon there with systemctl restart wsp-place-ecffdb75.service\n"), "{said}");
        let dialled = tokio::time::timeout(std::time::Duration::from_millis(300), squatter.accept()).await;
        assert!(dialled.is_err(), "a listener on loopback was dialled");
    }

    #[test]
    fn a_door_under_no_unit_the_join_wrote_sends_the_computer_to_be_added_again_and_names_no_restart() {
        let said = words::guest_no_door_line("box", std::path::Path::new("/root/.wsp/daemon.sock"), None);
        assert_eq!(
            said,
            "wsp on box reaches no daemon: nothing answers at /root/.wsp/daemon.sock; remove this computer from wsp and add it again"
        );
    }

    #[test]
    fn an_over_long_folder_keeps_its_end() {
        let deep = format!("/{}", "d".repeat(numbers::GUEST_CWD_MAX));
        let held = cut(&deep, numbers::GUEST_CWD_MAX);
        assert_eq!(held.chars().count(), numbers::GUEST_CWD_MAX);
        assert!(held.ends_with("dd"));
        assert_eq!(cut("/root", numbers::GUEST_CWD_MAX), "/root");
    }
}
