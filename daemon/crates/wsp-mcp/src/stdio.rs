// SPDX-License-Identifier: AGPL-3.0-only
//! JSON-RPC 2.0 over stdio, one message a line, as the MCP SDK's stdio server speaks it: the greeting, ping, the
//! tool list and tool calls, each call running beside the others. A line that is not JSON, a notification and an
//! answer from the client are read and dropped. Every line out has DEL and the C1 controls escaped, as the command
//! line's server writes through the protocol's escape. The greeting and the list are answered from what this build
//! carries, so neither dials, starts or looks for a host.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::checked;
use crate::host::Host;
use crate::json::{compact, escape_c1};
use crate::record;
use crate::tools::{self, input_refusal, Refused};

const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

#[derive(Deserialize)]
struct Incoming {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Greeting<'a> {
    protocol_version: &'a str,
    capabilities: Value,
    server_info: Value,
    instructions: &'a str,
}

#[derive(Deserialize)]
struct CallParams {
    name: String,
    #[serde(default)]
    arguments: Option<Value>,
}

pub async fn pump<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(host: Arc<Host>, input: R, mut output: W) -> i32 {
    let (answer, mut answered) = mpsc::unbounded_channel::<String>();
    let mut lines = input.split(b'\n');
    let mut calls = JoinSet::new();
    let mut reading = true;
    loop {
        tokio::select! {
            line = lines.next_segment(), if reading => match line {
                Ok(Some(line)) => take(&line, &host, &answer, &mut calls),
                _ => reading = false,
            },
            Some(line) = answered.recv() => {
                if write(&mut output, &line).await.is_err() {
                    return 1;
                }
            }
            Some(_) = calls.join_next(), if !calls.is_empty() => {}
        }
        if !reading && calls.is_empty() {
            while let Ok(line) = answered.try_recv() {
                if write(&mut output, &line).await.is_err() {
                    return 1;
                }
            }
            return 0;
        }
    }
}

async fn write<W: AsyncWrite + Unpin>(output: &mut W, line: &str) -> std::io::Result<()> {
    output.write_all(escape_c1(format!("{line}\n")).as_bytes()).await?;
    output.flush().await
}

fn take(line: &[u8], host: &Arc<Host>, answer: &mpsc::UnboundedSender<String>, calls: &mut JoinSet<()>) {
    let Ok(Incoming { id: Some(id), method: Some(method), params }) = serde_json::from_slice::<Incoming>(line) else { return };
    let id = id.to_string();
    match method.as_str() {
        "initialize" => {
            let _ = answer.send(result(&id, &greeting(params.as_ref(), host.cloud(), host.args().scoped, host.args().no_slate)));
        }
        "ping" => {
            let _ = answer.send(result(&id, "{}"));
        }
        "tools/list" => {
            let listed: Vec<String> = tools::listed(host.cloud(), host.args().guest).map(compact).collect();
            let _ = answer.send(result(&id, &format!(r#"{{"tools":[{}]}}"#, listed.join(","))));
        }
        "tools/call" => {
            let Some(asked) = params.and_then(|p| serde_json::from_value::<CallParams>(p).ok()) else {
                let _ = answer.send(error(&id, INVALID_PARAMS, "Invalid params"));
                return;
            };
            let host = host.clone();
            let answer = answer.clone();
            calls.spawn(async move {
                let _ = answer.send(result(&id, &called(host, asked).await));
            });
        }
        _ => {
            let _ = answer.send(error(&id, METHOD_NOT_FOUND, "Method not found"));
        }
    }
}

/// The version the client asked for where this server speaks it, else the newest it speaks, and the instructions for
/// the state WSP_CLOUD names, a thread's own when the server is scoped, without its slate when another thread started it.
fn greeting(params: Option<&Value>, cloud: bool, scoped: bool, no_slate: bool) -> String {
    let server = record::server();
    let asked = params.and_then(|p| p["protocolVersion"].as_str());
    let version = asked.filter(|v| server.protocol_versions.iter().any(|s| s == v)).unwrap_or(&server.latest_protocol_version);
    let greeting = Greeting {
        protocol_version: version,
        capabilities: serde_json::json!({ "tools": { "listChanged": true } }),
        server_info: serde_json::json!({ "name": server.name, "version": server.version }),
        instructions: match (scoped, no_slate, cloud) {
            (false, _, false) => &server.instructions.cloud_off,
            (false, _, true) => &server.instructions.cloud_on,
            (true, false, false) => &server.instructions.scoped_cloud_off,
            (true, false, true) => &server.instructions.scoped_cloud_on,
            (true, true, false) => &server.instructions.scoped_no_slate_cloud_off,
            (true, true, true) => &server.instructions.scoped_no_slate_cloud_on,
        },
    };
    serde_json::to_string(&greeting).unwrap_or_default()
}

async fn called(host: Arc<Host>, asked: CallParams) -> String {
    let Some((tool, entry)) = tools::named(&asked.name, host.cloud(), host.args().guest) else {
        return refused_text(&format!("MCP error -32602: Tool {} not found", asked.name));
    };
    let arguments = match refused_before_call(tool.name, entry, asked.arguments) {
        Ok(arguments) => arguments,
        Err(said) => return refused_text(&said),
    };
    match (tool.call)(host, arguments).await {
        Ok(answered) => format!(
            r#"{{"content":[{{"type":"text","text":{}}}],"structuredContent":{}{}}}"#,
            json_string(&answered.text),
            answered.structured,
            if answered.error { r#","isError":true"# } else { "" }
        ),
        Err(Refused::Input(said)) => refused_text(&said),
        Err(Refused::Failed(failure)) => {
            let object = serde_json::to_string(&failure.object()).unwrap_or_default();
            format!(
                r#"{{"content":[{{"type":"text","text":{}}}],"structuredContent":{object},"isError":true}}"#,
                json_string(&failure.message)
            )
        }
    }
}

/// The arguments a tool is called with, less any key its input does not list, or the words the SDK refuses them in
/// before the tool runs: anything but an object, then every issue the recorded input schema finds.
fn refused_before_call(tool: &str, listed: &str, arguments: Option<Value>) -> Result<Value, String> {
    let arguments = match arguments {
        Some(object @ Value::Object(_)) => object,
        other => return Err(input_refusal(tool, &format!("Invalid input: expected object, received {}", type_word(other.as_ref())))),
    };
    let schema = checked::input_schema(listed);
    let issues = checked::issues(&schema, &arguments);
    if issues.is_empty() {
        Ok(checked::known(&schema, arguments))
    } else {
        Err(input_refusal(tool, &issues.join("\n")))
    }
}

/// A call the SDK refuses before a tool runs: its text alone, marked as an error.
fn refused_text(said: &str) -> String {
    format!(r#"{{"content":[{{"type":"text","text":{}}}],"isError":true}}"#, json_string(said))
}

/// How the SDK's validator names what it was given where an object belongs.
fn type_word(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// A result in the order the SDK writes one.
fn result(id: &str, result: &str) -> String {
    format!(r#"{{"result":{result},"jsonrpc":"2.0","id":{id}}}"#)
}

fn error(id: &str, code: i64, message: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":{}}}}}"#, json_string(message))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_call_is_refused_before_its_tool_runs_as_the_sdk_refuses_it() {
        let listed = tools::entry_in(include_str!("../record/tools/exec.json"), false).unwrap();
        let refused = refused_before_call("exec", listed, Some(json!({ "workspace": 5, "argv": [] }))).unwrap_err();
        assert_eq!(refused, "MCP error -32602: Input validation error: Invalid arguments for tool exec: Expected string, received number at workspace\nArray must contain at least 1 element(s) at argv");
        let refused = refused_before_call("exec", listed, None).unwrap_err();
        assert_eq!(
            refused,
            "MCP error -32602: Input validation error: Invalid arguments for tool exec: Invalid input: expected object, received undefined"
        );
        let taken = json!({ "workspace": "w", "argv": ["ls"] });
        assert_eq!(refused_before_call("exec", listed, Some(taken.clone())), Ok(taken));
    }

    #[test]
    fn a_scoped_server_greets_with_the_threads_own_instructions() {
        let said = |cloud, scoped| serde_json::from_str::<Value>(&greeting(None, cloud, scoped, false)).unwrap()["instructions"].as_str().unwrap().to_owned();
        let server = record::server();
        for cloud in [false, true] {
            assert!(said(cloud, true).starts_with("This session is a wsp thread with a slate"));
            assert!(!said(cloud, false).contains("This session is a wsp thread"));
        }
        assert_eq!(said(false, false), server.instructions.cloud_off);
        assert_eq!(said(true, true), server.instructions.scoped_cloud_on);
    }

    #[test]
    fn a_thread_another_thread_started_is_greeted_with_no_word_of_a_slate() {
        let said = |cloud| serde_json::from_str::<Value>(&greeting(None, cloud, true, true)).unwrap()["instructions"].as_str().unwrap().to_owned();
        let server = record::server();
        for cloud in [false, true] {
            assert!(!said(cloud).to_lowercase().contains("slate"));
            assert!(server.instructions.cloud_off.contains("slate"));
        }
        assert_eq!(said(false), server.instructions.scoped_no_slate_cloud_off);
        assert_eq!(said(true), server.instructions.scoped_no_slate_cloud_on);
    }

    #[test]
    fn a_key_the_entry_does_not_list_reaches_no_tool() {
        let set = include_str!("../record/tools/computers_set.json");
        let asked = json!({ "computer": "c", "machines": 2, "nothing": 1 });
        let off = refused_before_call("computers_set", tools::entry_in(set, false).unwrap(), Some(asked.clone()));
        assert_eq!(off, Ok(json!({ "computer": "c" })));
        let on = refused_before_call("computers_set", tools::entry_in(set, true).unwrap(), Some(asked));
        assert_eq!(on, Ok(json!({ "computer": "c", "machines": 2 })));
    }
}
