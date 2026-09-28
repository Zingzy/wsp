// SPDX-License-Identifier: AGPL-3.0-only
//! One thread read off the transcript the host holds, as packages/protocol/src/thread-read.ts reads it: the messages
//! a reader sees, or the final reply alone, with each tool call folded to the one line the app's row reads and each
//! turn's end as the chat's footer states it. The rules are that file's and format.ts's, ported line for line.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

use crate::js;
use crate::words::{cost, duration, plural, title_line};

/// A row of a read: who spoke, when the runtime recorded it, and the text.
#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub who: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<Box<RawValue>>,
    pub text: String,
}

fn message(who: &str, at: Option<&RawValue>, text: String) -> Message {
    Message { who: who.to_owned(), at: at.map(RawValue::to_owned), text }
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    pub status: String,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    #[serde(default)]
    pub waited_ms: Option<f64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    #[serde(rename = "type")]
    event: String,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    at: Option<Box<RawValue>>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    tool_use_id: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    is_error: Option<bool>,
    #[serde(default)]
    result: Option<TurnResult>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
}

const NO_RESULT_LINE: &str = "turn ended without a result";

/// The events of this thread that a read folds, in order; an event of another kind, or one that does not read as its
/// kind's shape, is no row of it.
fn of_thread(events: &[Box<RawValue>], thread_id: &str) -> Vec<Event> {
    const READ: [&str; 5] = ["session.start", "session.steer", "session.delta", "session.done", "session.end"];
    events
        .iter()
        .filter_map(|raw| serde_json::from_str::<Event>(raw.get()).ok())
        .filter(|e| e.thread_id.as_deref() == Some(thread_id) && READ.contains(&e.event.as_str()))
        .collect()
}

fn failed(reason: Option<&String>) -> TurnResult {
    TurnResult {
        status: "failed".to_owned(),
        error: Some(reason.map_or(NO_RESULT_LINE, String::as_str).to_owned()),
        ..TurnResult::default()
    }
}

struct Call {
    row: usize,
    name: String,
    input: String,
}

/// `threadMessages`: every prompt and steer, the agent's text as it arrived, one row per tool call, each turn's end.
pub fn messages(events: &[Box<RawValue>], thread_id: &str) -> Vec<Message> {
    let mut rows: Vec<Message> = Vec::new();
    let mut open: Option<(usize, Option<String>)> = None;
    let mut calls: Vec<(String, Call)> = Vec::new();
    let mut saw_text = false;
    let mut replied = false;
    fn say(rows: &mut Vec<Message>, open: &mut Option<(usize, Option<String>)>, who: &str, at: Option<&RawValue>, text: String) -> usize {
        *open = None;
        rows.push(message(who, at, text));
        rows.len() - 1
    }
    let turn = |rows: &mut Vec<Message>,
                open: &mut Option<(usize, Option<String>)>,
                calls: &mut Vec<(String, Call)>,
                saw_text: &mut bool,
                at: Option<&RawValue>,
                result: &TurnResult| {
        if let Some(text) = result.text.as_ref().filter(|t| !*saw_text && !t.is_empty()) {
            say(rows, open, "agent", at, text.clone());
        }
        say(rows, open, "turn", at, turn_end_line(result));
        calls.clear();
        *saw_text = false;
    };
    for event in of_thread(events, thread_id) {
        let at = event.at.as_deref();
        match event.event.as_str() {
            "session.start" => {
                open = None;
                calls.clear();
                saw_text = false;
                replied = false;
                if let Some(prompt) = event.prompt {
                    say(&mut rows, &mut open, "person", at, prompt);
                }
            }
            "session.steer" => {
                say(&mut rows, &mut open, "person", at, event.prompt.unwrap_or_else(|| "undefined".to_owned()));
            }
            "session.delta" => {
                let text = event.text.clone().unwrap_or_default();
                match event.kind.as_deref() {
                    Some("text") => {
                        if text.is_empty() {
                            continue;
                        }
                        if let (Some((_, Some(open_id))), Some(id)) = (&open, &event.message_id) {
                            if id != open_id {
                                open = None;
                            }
                        }
                        match &open {
                            Some((row, _)) => rows[*row].text.push_str(&text),
                            None => {
                                rows.push(message("agent", at, text));
                                open = Some((rows.len() - 1, event.message_id.clone()));
                            }
                        }
                        saw_text = true;
                    }
                    Some("tool_result") => {
                        let answered =
                            event.tool_use_id.as_ref().and_then(|key| calls.iter().find(|(k, _)| k == key)).map(|(_, call)| call);
                        if let Some(call) = answered.filter(|_| event.is_error != Some(true)) {
                            if let Some(did) = tool_done_line(Some(&call.name), &call.input) {
                                rows[call.row].text = did;
                            }
                        }
                    }
                    Some("tool_use") => {
                        open = None;
                        let known = event.tool_use_id.as_ref().and_then(|key| calls.iter_mut().find(|(k, _)| k == key));
                        match known {
                            Some((_, call)) => {
                                if let Some(name) = &event.tool_name {
                                    call.name = name.clone();
                                }
                                call.input.push_str(&text);
                                rows[call.row].text = tool_activity_line(Some(&call.name), &call.input);
                            }
                            None => {
                                let row = say(&mut rows, &mut open, "tool", at, tool_activity_line(event.tool_name.as_deref(), &text));
                                if let Some(key) = event.tool_use_id.clone() {
                                    calls.push((
                                        key,
                                        Call { row, name: event.tool_name.clone().unwrap_or_else(|| "tool".to_owned()), input: text },
                                    ));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            "session.done" => {
                replied = true;
                let result = event.result.clone().unwrap_or_default();
                turn(&mut rows, &mut open, &mut calls, &mut saw_text, at, &result);
            }
            "session.end" if !replied => {
                turn(&mut rows, &mut open, &mut calls, &mut saw_text, at, &failed(event.reason.as_ref()));
            }
            _ => {}
        }
    }
    rows
}

struct Latest {
    at: Option<Box<RawValue>>,
    result: TurnResult,
    running: bool,
}

/// `latestTurn`: the thread's newest ended turn, read newest first, and whether a start has come after it.
fn latest_turn(events: &[Box<RawValue>], thread_id: &str) -> Option<Latest> {
    let mut end: Option<Event> = None;
    let mut running = false;
    for event in of_thread(events, thread_id).into_iter().rev() {
        match event.event.as_str() {
            "session.end" => {
                if end.is_some() {
                    break;
                }
                end = Some(event);
            }
            "session.done" if end.as_ref().is_none_or(|e| e.turn_id == event.turn_id) => {
                return Some(Latest { at: event.at, result: event.result.unwrap_or_default(), running });
            }
            "session.start" => match &end {
                None => running = true,
                Some(e) if e.turn_id == event.turn_id => break,
                Some(_) => {}
            },
            _ => {}
        }
    }
    let end = end?;
    Some(Latest { result: failed(end.reason.as_ref()), at: end.at, running })
}

/// `threadReplyRows`: the final reply alone, the agent's where the words are its own, and the note under it when the
/// thread has started another turn since.
pub fn reply_rows(events: &[Box<RawValue>], thread_id: &str, newer_turn: &str) -> Vec<Message> {
    let Some(latest) = latest_turn(events, thread_id) else { return Vec::new() };
    let reply = notify_reply(&latest.result);
    let body = notify_body(&latest.result).unwrap_or_else(|| turn_end_line(&latest.result));
    let who = if Some(&body) == reply.as_ref() { "agent" } else { "turn" };
    let mut rows = vec![message(who, latest.at.as_deref(), body)];
    if latest.running {
        rows.push(message("turn", None, newer_turn.to_owned()));
    }
    rows
}

/// `notifyReply` at its whole length.
fn notify_reply(result: &TurnResult) -> Option<String> {
    let text = js::trim(result.text.as_deref().unwrap_or(""));
    (!text.is_empty()).then(|| text.to_owned())
}

/// `notifyBody` at its whole length.
fn notify_body(result: &TurnResult) -> Option<String> {
    let reply = notify_reply(result);
    if result.status == "completed" {
        reply.or_else(|| result.error.clone())
    } else {
        result.error.clone().or(reply)
    }
}

/// `turnEndLine`: the footer, and why the turn did not complete where it did not.
pub fn turn_end_line(result: &TurnResult) -> String {
    let mut parts = vec![result.status.clone()];
    if let Some(total) = result.duration_ms {
        let waited = result.waited_ms.filter(|w| *w > 0.0).unwrap_or(0.0).min(total);
        let worked = total - waited;
        parts.push(format!("Worked for {}", duration(worked)));
        if waited > worked {
            parts.push(format!("waited on you {}", duration(waited)));
        }
    }
    if let Some(usd) = result.cost_usd {
        parts.push(cost(usd));
    }
    let settled = parts.join("  ");
    match result.error.as_ref().filter(|_| result.status != "completed") {
        Some(failure) => format!("{settled}: {failure}"),
        None => settled,
    }
}

/// A field of a call's input that is text with something in it.
fn field<'a>(input: &'a Value, name: &str) -> Option<&'a str> {
    input.get(name).and_then(Value::as_str).filter(|v| !js::trim(v).is_empty())
}

enum Moment {
    Asked,
    Done,
}

/// The line a call of one tool reads as at one moment: the row TOOL_ROWS in format.ts holds for its name.
fn row_line(name: &str, input: &Value, moment: Moment) -> Option<Option<String>> {
    let done = matches!(moment, Moment::Done);
    let path = |doing: &str, did: &str, key: &str| field(input, key).map(|p| format!("{} {p}", if done { did } else { doing }));
    let about = |doing: &str, did: Option<&str>, key: &str| {
        field(input, key).map(|w| format!("{} {}", did.filter(|_| done).unwrap_or(doing), title_line(w)))
    };
    Some(match name {
        "Bash" | "command_execution" => field(input, "command").map(|c| format!("$ {}", title_line(c))),
        "Read" => path("reading", "read", "file_path"),
        "Write" => path("writing", "wrote", "file_path"),
        "Edit" | "MultiEdit" => path("editing", "edited", "file_path"),
        "NotebookEdit" => path("editing", "edited", "notebook_path"),
        "file_change" => {
            let paths: Vec<&str> = input
                .get("changes")
                .and_then(Value::as_array)
                .map(|c| c.iter().filter_map(|c| c.get("path").and_then(Value::as_str).filter(|p| !p.is_empty())).collect())
                .unwrap_or_default();
            let verb = if done { "edited" } else { "editing" };
            match paths.as_slice() {
                [] => None,
                [one] => Some(format!("{verb} {one}")),
                many => Some(format!("{verb} {}", plural(many.len(), "file"))),
            }
        }
        "Grep" | "Glob" => about("searching code for", Some("searched code for"), "pattern"),
        "WebSearch" | "web_search" => about("searching the web for", Some("searched the web for"), "query"),
        "WebFetch" => about("fetching", Some("fetched"), "url"),
        "Task" | "Agent" => about("agent:", None, "description"),
        "AskUserQuestion" => first_question(input).map(|q| format!("asked: {q}")),
        _ => return None,
    })
}

/// The first question a question call carries that offers at least one choice: `questionsIn`'s first.
fn first_question(input: &Value) -> Option<&str> {
    input.get("questions")?.as_array()?.iter().filter(|q| q.is_object()).find_map(|q| {
        let text = field(q, "question")?;
        let labelled =
            q.get("options").and_then(Value::as_array).is_some_and(|o| o.iter().any(|o| o.is_object() && field(o, "label").is_some()));
        labelled.then_some(text)
    })
}

/// The call's input as an object, or nothing while it is still arriving or when it is not one.
fn tool_input(input: &str) -> Option<Value> {
    serde_json::from_str::<Value>(input).ok().filter(Value::is_object)
}

/// `toolActivityLine`.
pub fn tool_activity_line(tool_name: Option<&str>, input: &str) -> String {
    let name = tool_name.unwrap_or("tool");
    let Some(fields) = tool_input(input) else { return name.to_owned() };
    row_line(name, &fields, Moment::Asked).flatten().unwrap_or_else(|| name.to_owned())
}

/// `toolDoneLine`.
pub fn tool_done_line(tool_name: Option<&str>, input: &str) -> Option<String> {
    let name = tool_name.unwrap_or("tool");
    let fields = tool_input(input)?;
    let done = row_line(name, &fields, Moment::Done)??;
    (Some(&done) != row_line(name, &fields, Moment::Asked).flatten().as_ref()).then_some(done)
}

/// `fmtClock`: the time of day a row was recorded at, to the second, in this computer's zone.
fn clock(at: Option<&RawValue>) -> String {
    let Some(at) = at else { return String::new() };
    let ms = at.get().parse::<f64>().unwrap_or(f64::NAN);
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return "Invalid ".to_owned();
    }
    let seconds = (ms.trunc() / 1_000.0).floor() as libc::time_t;
    // SAFETY: tzset reads the zone once for the process, and localtime_r writes only the tm it is handed.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        tzset();
        libc::localtime_r(&seconds, &mut tm);
    }
    format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
}

extern "C" {
    fn tzset();
}

/// `threadReadText`: each row as who and when on its own line with the text under it, a blank line between rows.
pub fn read_text(rows: &[Message]) -> String {
    rows.iter()
        .map(|row| {
            let at = clock(row.at.as_deref());
            let head = if at.is_empty() { row.who.clone() } else { format!("{} {at}", row.who) };
            format!("{head}\n{}", row.text)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(lines: &[&str]) -> Vec<Box<RawValue>> {
        lines.iter().map(|l| RawValue::from_string((*l).to_owned()).unwrap()).collect()
    }

    #[test]
    fn a_turn_folds_to_its_prompt_its_words_its_calls_and_its_end() {
        let e = events(&[
            r#"{"type":"session.start","threadId":"t","turnId":"1","prompt":"go","at":5}"#,
            r#"{"type":"session.delta","threadId":"t","kind":"text","text":"Look","messageId":"m1"}"#,
            r#"{"type":"session.delta","threadId":"t","kind":"text","text":"ing","messageId":"m1"}"#,
            r#"{"type":"session.delta","threadId":"t","kind":"tool_use","toolUseId":"u","toolName":"Read","text":"{\"file_path\""}"#,
            r#"{"type":"session.delta","threadId":"t","kind":"tool_use","toolUseId":"u","text":":\"/a\"}"}"#,
            r#"{"type":"session.delta","threadId":"t","kind":"tool_result","toolUseId":"u"}"#,
            r#"{"type":"session.delta","threadId":"other","kind":"text","text":"not ours"}"#,
            r#"{"type":"session.done","threadId":"t","turnId":"1","result":{"status":"completed","durationMs":1250,"costUsd":0.125,"text":"Looking"}}"#,
        ]);
        let rows: Vec<(String, String)> = messages(&e, "t").into_iter().map(|m| (m.who, m.text)).collect();
        let want = [("person", "go"), ("agent", "Looking"), ("tool", "read /a"), ("turn", "completed  Worked for 1.3s  $0.13")];
        assert_eq!(rows, want.map(|(a, b)| (a.to_owned(), b.to_owned())));
    }

    #[test]
    fn the_reply_is_the_newest_ended_turn_and_says_when_another_runs() {
        let e = events(&[
            r#"{"type":"session.start","threadId":"t","turnId":"1"}"#,
            r#"{"type":"session.done","threadId":"t","turnId":"1","result":{"status":"failed","error":"boom","text":" words "}}"#,
            r#"{"type":"session.start","threadId":"t","turnId":"2"}"#,
        ]);
        let rows: Vec<(String, String)> = reply_rows(&e, "t", "newer").into_iter().map(|m| (m.who, m.text)).collect();
        assert_eq!(rows, vec![("turn".to_owned(), "boom".to_owned()), ("turn".to_owned(), "newer".to_owned())]);
    }
}
