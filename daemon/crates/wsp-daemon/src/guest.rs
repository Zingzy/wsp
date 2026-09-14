// SPDX-License-Identifier: AGPL-3.0-only
//! The guest relay: a process inside this machine opens a session on its own daemon, and the daemon carries that
//! session up the socket the host already holds to it. Nothing here reads the token a session carries or the
//! messages that ride it; the host is what reads both. The whole of the daemon's part is routing frames between one
//! guest socket and the socket that asked to watch.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;
use wsp_frames::{numbers, words, DaemonErrorCode, DaemonEvent, GuestOpen};

use crate::ops::Conn;
use crate::paths::OpError;
use crate::Outbound;

/// One open session: the guest socket it belongs to, and the frames it holds while no watcher is attached.
struct Session {
    key: u64,
    out: Outbound,
    /// The order sessions were opened in, so a flush hands a watcher the sessions as they came.
    at: u64,
    queued: Vec<DaemonEvent>,
    /// The guest's end is gone and its close is the last thing queued: the row stands only until a watcher has been
    /// handed that frame, so a host arriving after the fact still hears the session end rather than holding its own
    /// row and its socket for the life of the machine.
    ended: bool,
}

#[derive(Default)]
struct State {
    /// Every socket that asked to watch, most recent last: frames go to the last, and a socket that has watched at
    /// all may answer. A short-lived link of the host's takes the pushes while it is up and hands them back when it
    /// goes, so a reach opened for one question does not leave the sessions of a longer one with no reader.
    watchers: Vec<(u64, Outbound)>,
    sessions: HashMap<String, Session>,
}

#[derive(Default)]
pub(crate) struct Guests {
    state: Mutex<State>,
    ids: AtomicU64,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

fn no_such_session(session: &str) -> OpError {
    OpError::coded(DaemonErrorCode::NotFound, format!("no such guest session: {session}"))
}

impl State {
    fn watching(&self) -> Option<&Outbound> {
        self.watchers.last().map(|(_, out)| out)
    }

    /// Up to whoever is watching, or into the session's own queue; a queue past its cap ends the session, which is
    /// what a guest reads when the host has been away too long.
    fn upward(&mut self, session: &str, event: DaemonEvent) -> Option<Outbound> {
        if let Some(out) = self.watching() {
            out.send_event(&event);
            return None;
        }
        let held = self.sessions.get_mut(session)?;
        if held.queued.len() >= numbers::GUEST_QUEUE_CAP_FRAMES {
            let gone = self.sessions.remove(session)?;
            return Some(gone.out);
        }
        held.queued.push(event);
        None
    }
}

impl Guests {
    /// One session per socket: a second open on the same socket is the client's own mistake, not a second session.
    pub(crate) fn open(&self, conn: &Conn, open: GuestOpen) -> Result<String, OpError> {
        let at = self.ids.fetch_add(1, Ordering::Relaxed);
        let session = format!("g{at}");
        conn.take_guest(session.clone())?;
        let opened = DaemonEvent::GuestOpened {
            session: session.clone(),
            kind: open.kind,
            token: open.token,
            turn_token: open.turn_token,
            argv: open.argv,
            cwd: open.cwd,
        };
        let mut state = lock(&self.state);
        state.sessions.insert(session.clone(), Session { key: conn.key, out: conn.out.clone(), at, queued: Vec::new(), ended: false });
        // The open cannot overflow its own queue, so nothing comes back to close here.
        state.upward(&session, opened);
        Ok(session)
    }

    pub(crate) fn send(&self, conn: &Conn, message: Value) -> Result<(), OpError> {
        let session = conn.guest_session().ok_or_else(|| OpError::coded(DaemonErrorCode::BadRequest, NO_SESSION))?;
        if message.to_string().len() > numbers::GUEST_MESSAGE_CAP_BYTES {
            return Err(OpError::coded(DaemonErrorCode::BadRequest, over_the_cap()));
        }
        let mut state = lock(&self.state);
        if !state.sessions.contains_key(&session) {
            return Err(no_such_session(&session));
        }
        let full = state.upward(&session, DaemonEvent::GuestMessage { session: session.clone(), message });
        drop(state);
        if let Some(out) = full {
            out.send_event(&DaemonEvent::GuestClosed { session, error: Some(words::GUEST_QUEUE_FULL.to_owned()) });
        }
        Ok(())
    }

    /// This socket takes the sessions from here on, and everything held while nobody was reading goes to it now, in
    /// the order the sessions were opened and the frames arrived. A session whose guest went while nobody watched
    /// hands over its close and is then dropped, so the row it left is one frame long.
    pub(crate) fn watch(&self, conn: &Conn) {
        let mut state = lock(&self.state);
        state.watchers.retain(|(key, _)| *key != conn.key);
        state.watchers.push((conn.key, conn.out.clone()));
        let mut held: Vec<(u64, Vec<DaemonEvent>)> =
            state.sessions.values_mut().filter(|s| !s.queued.is_empty()).map(|s| (s.at, std::mem::take(&mut s.queued))).collect();
        held.sort_by_key(|(at, _)| *at);
        for event in held.iter().flat_map(|(_, events)| events) {
            conn.out.send_event(event);
        }
        state.sessions.retain(|_, s| !s.ended);
    }

    pub(crate) fn reply(&self, conn: &Conn, session: &str, message: Value) -> Result<(), OpError> {
        let state = lock(&self.state);
        Guests::watcher(&state, conn)?;
        let held = state.sessions.get(session).ok_or_else(|| no_such_session(session))?;
        held.out.send_event(&DaemonEvent::GuestMessage { session: session.to_owned(), message });
        Ok(())
    }

    pub(crate) fn close(&self, conn: &Conn, session: &str, error: Option<String>) -> Result<(), OpError> {
        let mut state = lock(&self.state);
        Guests::watcher(&state, conn)?;
        let gone = state.sessions.remove(session).ok_or_else(|| no_such_session(session))?;
        drop(state);
        gone.out.send_event(&DaemonEvent::GuestClosed { session: session.to_owned(), error });
        Ok(())
    }

    /// A socket is gone: it stops watching, and any session it opened ends upward. With nobody watching the close is
    /// queued like any other frame and the row stands for it alone, so the next watcher hears the end. The sessions
    /// of a watcher that left stand whole, since the host holds them by id and its next socket asks to watch again.
    pub(crate) fn socket_closed(&self, key: u64) {
        let mut state = lock(&self.state);
        state.watchers.retain(|(held, _)| *held != key);
        let ended: Vec<String> = state.sessions.iter().filter(|(_, s)| s.key == key).map(|(id, _)| id.clone()).collect();
        for session in ended {
            let closed = DaemonEvent::GuestClosed { session: session.clone(), error: None };
            match state.watching() {
                Some(out) => {
                    out.send_event(&closed);
                    state.sessions.remove(&session);
                }
                None => {
                    if let Some(held) = state.sessions.get_mut(&session) {
                        held.ended = true;
                        held.queued.push(closed);
                    }
                }
            }
        }
    }

    /// Only a socket that has asked to watch may answer or end a session; every other one is told so by name.
    fn watcher(state: &State, conn: &Conn) -> Result<(), OpError> {
        if state.watchers.iter().any(|(key, _)| *key == conn.key) {
            return Ok(());
        }
        Err(OpError::coded(DaemonErrorCode::Forbidden, words::GUEST_NOT_WATCHER))
    }
}

pub(crate) const NO_SESSION: &str = "this socket has opened no guest session";
pub(crate) const SESSION_TAKEN: &str = "this socket already holds a guest session";

fn over_the_cap() -> String {
    format!("a guest message is at most {} bytes of JSON", numbers::GUEST_MESSAGE_CAP_BYTES)
}
