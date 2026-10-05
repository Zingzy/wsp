// SPDX-License-Identifier: AGPL-3.0-only
//! The tools that act on one thread and answer at once: `stop`, `thread_rename`, `thread_forget`, and `thread_allow`
//! and `thread_deny`, which answer the prompt a thread is stopped on off the transcript the host holds.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::named::{awake, history, params, thread_of, with_outcome, workspace_of};
use super::said::{fmt_bytes, js_trim, thread_word, turns};
use super::{input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::fill;

pub const STOP: Tool =
    Tool { name: "stop", listed: include_str!("../../record/tools/stop.json"), call: |host, args| Box::pin(stop(host, args)) };
pub const RENAME: Tool = Tool {
    name: "thread_rename",
    listed: include_str!("../../record/tools/thread_rename.json"),
    call: |host, args| Box::pin(rename(host, args)),
};
pub const FORGET: Tool = Tool {
    name: "thread_forget",
    listed: include_str!("../../record/tools/thread_forget.json"),
    call: |host, args| Box::pin(forget(host, args)),
};
pub const ALLOW: Tool = Tool {
    name: "thread_allow",
    listed: include_str!("../../record/tools/thread_allow.json"),
    call: |host, args| Box::pin(answer("thread_allow", "allow", host, args)),
};
pub const DENY: Tool = Tool {
    name: "thread_deny",
    listed: include_str!("../../record/tools/thread_deny.json"),
    call: |host, args| Box::pin(answer("thread_deny", "deny", host, args)),
};

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ThreadIn {
    pub thread: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct StopIn {
    pub thread: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct StopOut {
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub under: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

async fn stop(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let StopIn { thread, task } = input("stop", arguments)?;
    let client = host.client().await?;
    let thread = thread_of(&client, &thread).await?;
    #[derive(Deserialize)]
    struct Interrupted {
        outcome: String,
        #[serde(default)]
        under: Option<Vec<String>>,
        #[serde(default)]
        error: Option<String>,
    }
    let mut asked = params([("sessionId", Value::from(thread.session_id.as_str()))]);
    if let Some(task) = &task {
        asked.insert("task".to_owned(), Value::from(task.as_str()));
    }
    let reply = client.request("sessions.interrupt", asked).await?;
    let Interrupted { outcome, under, error } =
        with_outcome("sessions.interrupt", reply, &["accepted", "not-running", "not-found", "refused", "unsupported"])?;
    let under = under.filter(|u| !u.is_empty());
    let words = turns();
    if let Some(named) = &task {
        let filled = [("thread", thread.id.as_str()), ("task", named.as_str()), ("error", error.as_deref().unwrap_or(""))];
        let line = match &error {
            Some(_) => fill(&words.stop_task_said, &filled),
            None => fill(words.stopped_task.get(&outcome).map_or("", String::as_str), &filled),
        };
        return Ok(Answer::text(line, &StopOut { thread_id: thread.id, task, outcome, under, error }));
    }
    let mut line = fill(words.stopped.get(&outcome).map_or("", String::as_str), &[("thread", &thread.id)]);
    match under.as_deref() {
        None => {}
        Some([one]) => line.push_str(&fill(&words.stop_under_one, &[("under", &thread_word(one))])),
        Some(several) => {
            let named: Vec<String> = several.iter().map(|id| thread_word(id)).collect();
            line.push_str(&fill(&words.stop_under_some, &[("count", &several.len().to_string()), ("under", &named.join(", "))]));
        }
    }
    Ok(Answer::text(line, &StopOut { thread_id: thread.id, task: None, outcome, under, error }))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RenameIn {
    pub thread: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RenameOut {
    pub thread_id: String,
    pub title: String,
    pub harness: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

async fn rename(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let RenameIn { thread, title } = input("thread_rename", arguments)?;
    let client = host.client().await?;
    let thread = thread_of(&client, &thread).await?;
    awake(&client, &workspace_of(&client, &thread.workspace_id).await?, "rename").await?;
    #[derive(Deserialize)]
    struct Renamed {
        outcome: String,
        #[serde(default)]
        error: Option<String>,
    }
    let asked = params([("sessionId", Value::from(thread.session_id.as_str())), ("title", Value::from(title.as_str()))]);
    let reply = client.request("sessions.rename", asked).await?;
    let Renamed { outcome, error } =
        with_outcome("sessions.rename", reply, &["renamed", "unsupported", "no-session", "failed", "not-found"])?;
    let words = turns();
    let agent = words.agents.get(&thread.harness).unwrap_or(&thread.harness);
    let template = match (outcome.as_str(), &error) {
        ("failed", None) => &words.rename_failed_silent,
        _ => words.renamed.get(&outcome).unwrap_or(&words.rename_failed_silent),
    };
    let line = fill(template, &[("thread", &thread.id), ("title", &title), ("agent", agent), ("error", error.as_deref().unwrap_or(""))]);
    Ok(Answer::text(line, &RenameOut { thread_id: thread.id, title, harness: thread.harness, outcome, error }))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ForgetOut {
    pub thread_id: String,
    pub workspace_id: String,
}

async fn forget(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ThreadIn { thread } = input("thread_forget", arguments)?;
    let client = host.client().await?;
    let thread = thread_of(&client, &thread).await?;
    let Some(runtime) = thread.thread_id.as_deref() else {
        return Err(Failure::new(fill(&turns().thread_without_id, &[("row", &thread.id)])).into());
    };
    client.request::<Value>("sessions.forget", params([("threadId", Value::from(runtime))])).await?;
    let line = fill(&turns().thread_forgot, &[("thread", &thread.id)]);
    Ok(Answer::text(line, &ForgetOut { thread_id: thread.id, workspace_id: thread.workspace_id }))
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AnswerOut {
    pub thread_id: String,
    pub ask_id: String,
    pub option_id: String,
}

/// A permission prompt as the transcript carries it, as far as answering one reads it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ask {
    session_id: String,
    ask_id: String,
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    input: String,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    options: Vec<AskOption>,
}

#[derive(Debug, Clone, Deserialize)]
struct AskOption {
    id: String,
    #[serde(default)]
    effect: String,
}

/// The prompt the thread is stopped on: the oldest opened and not closed, as packages/protocol/src/thread-read.ts
/// `openAsk` reads it. A prompt opened again keeps its first place.
fn open_ask(events: &[Value], thread_id: &str) -> Option<Ask> {
    let mut open: Vec<(String, Value)> = Vec::new();
    for event in events.iter().filter(|e| e.get("threadId").and_then(Value::as_str) == Some(thread_id)) {
        let Some(ask_id) = event.get("askId").and_then(Value::as_str) else { continue };
        match event.get("type").and_then(Value::as_str) {
            Some("session.permission") => match open.iter_mut().find(|(id, _)| id == ask_id) {
                Some(held) => held.1 = event.clone(),
                None => open.push((ask_id.to_owned(), event.clone())),
            },
            Some("session.permission.closed") => open.retain(|(id, _)| id != ask_id),
            _ => {}
        }
    }
    open.into_iter().next().and_then(|(_, event)| serde_json::from_value(event).ok())
}

async fn answer(tool: &'static str, effect: &'static str, host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ThreadIn { thread } = input(tool, arguments)?;
    let words = turns();
    let road =
        words.answer_roads.iter().find(|r| r.effect == effect).ok_or_else(|| Failure::new(format!("no answer road for {effect}")))?;
    let client = host.client().await?;
    let thread = thread_of(&client, &thread).await?;
    let thread_id = thread.runtime_id().to_owned();
    let named = thread_word(&thread_id);
    let Some(ask) = open_ask(&history(&client, &thread.workspace_id).await?, &thread_id) else {
        return Err(Failure::new(fill(&words.no_open_ask, &[("thread", &named)])).into());
    };
    let Some(option) = ask.options.iter().find(|o| o.effect == road.effect) else {
        return Err(Failure::new(fill(&road.no_such_answer, &[("thread", &named)])).into());
    };
    #[derive(Deserialize)]
    struct Answered {
        outcome: String,
    }
    let asked = params([
        ("sessionId", Value::from(ask.session_id.as_str())),
        ("askId", Value::from(ask.ask_id.as_str())),
        ("optionId", Value::from(option.id.as_str())),
    ]);
    let reply = client.request("sessions.answer", asked).await?;
    let Answered { outcome } = with_outcome("sessions.answer", reply, &["answered", "gone", "unsupported", "not-found", "no-option"])?;
    if outcome != "answered" {
        return Err(Failure::new(words.answer_words.get(&outcome).cloned().unwrap_or(outcome)).into());
    }
    let line = fill(
        &words.answered,
        &[("said", &road.said), ("thread", &named), ("ask", &asking_line(&ask.tool_name, &ask.input, ask.detail.as_deref()))],
    );
    Ok(Answer::text(line, &AnswerOut { thread_id, ask_id: ask.ask_id, option_id: option.id.clone() }))
}

/// A string field with something in it, as the prompt's words read one.
fn field<'a>(fields: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    fields.get(name).and_then(Value::as_str).filter(|v| !js_trim(v).is_empty())
}

fn folder_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(path)
}

fn parent_folder_name(path: &str) -> &str {
    let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    if parts.len() < 2 {
        ""
    } else {
        parts[parts.len() - 2]
    }
}

/// The first question a question call puts. One with no choice to pick counts: it draws as the one field a typed
/// answer goes into.
fn first_question(fields: &Map<String, Value>) -> Option<String> {
    fields.get("questions")?.as_array()?.iter().find_map(|entry| field(entry.as_object()?, "question").map(str::to_owned))
}

/// A file's name and its folder as a person says them, in the kind's own templates: `health.ts in src`.
fn file_in_folder(asks_name: &str, asks_in: &str, path: &str) -> String {
    let folder = parent_folder_name(path);
    let mut says = fill(asks_name, &[("name", folder_name(path))]);
    if !folder.is_empty() {
        says.push_str(&fill(asks_in, &[("folder", folder)]));
    }
    says
}

/// The prompt's lead as one line, in the words its kind of call is put to a person in, as
/// packages/protocol/src/format.ts `permissionAskLine` puts it.
fn asking_line(tool: &str, input: &str, detail: Option<&str>) -> String {
    let asks = &turns().asks;
    let fields = serde_json::from_str::<Value>(input).ok().and_then(|v| v.as_object().cloned());
    let lead = fields.as_ref().and_then(|fields| match tool {
        "Write" => field(fields, "file_path").map(|path| {
            let mut says = file_in_folder(&asks.write, &asks.write_in, path);
            if let Some(content) = fields.get("content").and_then(Value::as_str) {
                says.push_str(&fill(&asks.write_size, &[("size", &fmt_bytes(content.len() as f64))]));
            }
            says
        }),
        "Edit" | "MultiEdit" => field(fields, "file_path").map(|path| {
            let mut says = file_in_folder(&asks.edit, &asks.edit_in, path);
            if let Some(edits) = fields.get("edits").and_then(Value::as_array).filter(|edits| edits.len() > 1) {
                says.push_str(&fill(&asks.edit_places, &[("count", &edits.len().to_string())]));
            }
            says
        }),
        "Bash" | "command_execution" => field(fields, "command").map(|command| fill(&asks.command, &[("command", command)])),
        "WebFetch" => field(fields, "url").map(|url| fill(&asks.fetch, &[("url", url)])),
        "file_change" => fields.get("changes").and_then(Value::as_array).and_then(|changes| {
            let paths: Vec<&str> = changes.iter().filter_map(|c| field(c.as_object()?, "path")).collect();
            match paths.as_slice() {
                [] => None,
                [one] => Some(file_in_folder(&asks.change, &asks.change_in, one)),
                many => Some(fill(
                    &asks.changes,
                    &[("count", &many.len().to_string()), ("names", &many.iter().map(|p| folder_name(p)).collect::<Vec<_>>().join(", "))],
                )),
            }
        }),
        "Skill" => field(fields, "skill").map(|skill| fill(&asks.skill, &[("skill", skill)])),
        "AskUserQuestion" => first_question(fields),
        _ => {
            let parts: Vec<&str> = tool.split("__").collect();
            (parts.len() >= 3 && parts[0] == "mcp" && !parts[1].is_empty())
                .then(|| fill(&asks.server, &[("server", parts[1]), ("tool", &parts[2..].join("__").replace('_', " "))]))
        }
    });
    lead.unwrap_or_else(|| match detail {
        None | Some("") => fill(&asks.plain, &[("tool", tool)]),
        Some(detail) => fill(&asks.plain_detail, &[("tool", tool), ("detail", detail)]),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::tools::held::to_the_record;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<StopIn, StopOut>(STOP.listed);
        to_the_record::<RenameIn, RenameOut>(RENAME.listed);
        to_the_record::<ThreadIn, ForgetOut>(FORGET.listed);
        to_the_record::<ThreadIn, AnswerOut>(ALLOW.listed);
        to_the_record::<ThreadIn, AnswerOut>(DENY.listed);
    }

    #[test]
    fn the_open_prompt_is_the_oldest_still_open() {
        let ask = |id: &str, tool: &str| json!({ "type": "session.permission", "threadId": "t", "sessionId": "s", "askId": id, "toolName": tool, "input": "", "options": [] });
        let closed = |id: &str| json!({ "type": "session.permission.closed", "threadId": "t", "askId": id });
        let events = [
            ask("a", "One"),
            ask("b", "Two"),
            ask("a", "Again"),
            closed("c"),
            json!({ "type": "session.permission", "threadId": "u", "askId": "z", "sessionId": "s" }),
        ];
        let open = open_ask(&events, "t").unwrap();
        assert_eq!((open.ask_id.as_str(), open.tool_name.as_str()), ("a", "Again"));
        assert_eq!(open_ask(&[ask("a", "One"), closed("a")], "t").map(|a| a.ask_id), None);
    }

    #[test]
    fn a_question_leads_with_its_first_question_choices_or_not() {
        // A question with no choices stands, as `questionsIn` keeps it: it is the one field a typed answer goes into.
        let input = json!({ "questions": [{ "question": "A name?", "options": [] }, { "question": "Which one?", "options": [{ "label": " " }, { "label": "A" }] }] });
        assert_eq!(asking_line("AskUserQuestion", &input.to_string(), None), "A name?");
        let choices = json!({ "questions": [{ "question": "Which one?", "options": [{ "label": "A" }] }] });
        assert_eq!(asking_line("AskUserQuestion", &choices.to_string(), None), "Which one?");
        // The new rows word their calls as the protocol's table does, folder and count included.
        assert_eq!(asking_line("Edit", &json!({ "file_path": "/w/src/a.ts" }).to_string(), None), "Edit a.ts in src");
        assert_eq!(
            asking_line("MultiEdit", &json!({ "file_path": "a.ts", "edits": [{}, {}, {}] }).to_string(), None),
            "Edit a.ts (3 places)"
        );
        assert_eq!(asking_line("WebFetch", &json!({ "url": "https://x.y/z" }).to_string(), None), "Fetch a page: https://x.y/z");
        assert_eq!(
            asking_line("command_execution", &json!({ "command": "ls", "cwd": "/w" }).to_string(), Some("why")),
            "Run a command: ls"
        );
        assert_eq!(asking_line("file_change", &json!({ "changes": [{ "path": "/w/a.rs" }] }).to_string(), None), "Change a.rs in w");
        assert_eq!(
            asking_line("file_change", &json!({ "changes": [{ "path": "/w/a.rs" }, { "path": "b.rs" }] }).to_string(), None),
            "Change 2 files: a.rs, b.rs"
        );
        assert_eq!(folder_name("/a/b/"), "b");
        assert_eq!(parent_folder_name("b"), "");
    }
}
