// SPDX-License-Identifier: AGPL-3.0-only
//! `agents`, `skills` and `servers`: one read of what stands on a computer or a workspace, each tool answering its own
//! rows beside the report's facts, its text the table the command line prints. The report is parsed as the TypeScript
//! tool parses it, so its fields come out in the schema's order and without any the schema does not name.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::{entry_in, input, Answer, Refused, Tool};
use crate::client::Client;
use crate::failure::Failure;
use crate::host::Host;
use crate::record::{self, fill};
use crate::words::{cell, table};
use crate::zod::{self, Ordered, Schema};

const AGENTS_LISTED: &str = include_str!("../../record/tools/agents.json");
const SKILLS_LISTED: &str = include_str!("../../record/tools/skills.json");
const SERVERS_LISTED: &str = include_str!("../../record/tools/servers.json");

pub const AGENTS: Tool = Tool { name: "agents", listed: AGENTS_LISTED, call: |host, args| Box::pin(call(host, args, Rows::Agents)) };
pub const SKILLS: Tool = Tool { name: "skills", listed: SKILLS_LISTED, call: |host, args| Box::pin(call(host, args, Rows::Skills)) };
pub const SERVERS: Tool = Tool { name: "servers", listed: SERVERS_LISTED, call: |host, args| Box::pin(call(host, args, Rows::Servers)) };

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct In {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
}

/// What every one of the three answers beside its rows: `reportFacts` in packages/host/src/verbs.ts, in its order.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub target: Box<RawValue>,
    pub home: String,
    pub user: String,
    pub read_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale: Option<String>,
    pub refused: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<Vec<serde_json::Value>>"))]
    pub projects: Option<Box<RawValue>>,
    /// Listed in the output schema and never answered: `reportFacts` leaves it out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reach: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AgentsOut {
    #[serde(flatten)]
    pub facts: Facts,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub agents: Box<RawValue>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SkillsOut {
    #[serde(flatten)]
    pub facts: Facts,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub skills: Box<RawValue>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ServersOut {
    #[serde(flatten)]
    pub facts: Facts,
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub servers: Box<RawValue>,
}

#[derive(Clone, Copy, PartialEq)]
enum Rows {
    Agents,
    Skills,
    Servers,
}

impl Rows {
    const ALL: [Rows; 3] = [Rows::Agents, Rows::Skills, Rows::Servers];

    /// The tool's name, which is also the report's field its rows are under.
    fn name(self) -> &'static str {
        match self {
            Rows::Agents => "agents",
            Rows::Skills => "skills",
            Rows::Servers => "servers",
        }
    }

    fn listed(self) -> &'static str {
        match self {
            Rows::Agents => AGENTS_LISTED,
            Rows::Skills => SKILLS_LISTED,
            Rows::Servers => SERVERS_LISTED,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRow {
    name: String,
    installed: bool,
    version: Option<String>,
    latest: Option<String>,
    sign_in: String,
    wsp_tools: bool,
    path: Option<String>,
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillPath {
    path: String,
    link_to: Option<String>,
}

#[derive(Deserialize)]
struct SkillRow {
    name: String,
    paths: Vec<SkillPath>,
    scope: String,
    project: Option<Named>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpRow {
    agent: String,
    name: String,
    scope: String,
    file: String,
    transport: Transport,
    auth: String,
    enabled: bool,
    in_recipe: Option<bool>,
    project: Option<Named>,
}

#[derive(Deserialize)]
struct Transport {
    kind: String,
    line: Option<String>,
    host: Option<String>,
}

#[derive(Deserialize)]
struct Report {
    report: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Resolved {
    workspace: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct Place {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct Places {
    places: Vec<Place>,
}

/// The place a word names, by its name or its id; a word naming none is refused with the names there are: `placeNamed`.
pub async fn place_named(client: &Client, word: &str) -> Result<(String, String), Failure> {
    let listed = client.request::<Places>("places.list", Map::new()).await?;
    let names: Vec<&str> = listed.places.iter().map(|p| p.name.as_str()).collect();
    match listed.places.iter().find(|p| p.id == word || p.name == word) {
        Some(place) => Ok((place.id.clone(), place.name.clone())),
        None => {
            let words = record::words();
            let said = fill(&words.no_such_place, &[("word", word), ("held", &names.join(", "))]);
            Err(Failure::usage(super::target::refusal_line(&said, &words.places_fix)))
        }
    }
}

/// The workspace a person names, by id or by its name when one carries it: `workspaceOf`, whose id is all this reads.
pub async fn workspace_id(client: &Client, reference: &str) -> Result<String, Failure> {
    let op = "workspaces.resolve";
    let mut params = Map::new();
    params.insert("ref".to_owned(), Value::from(reference));
    let resolved = client.request::<Resolved>(op, params).await?;
    #[derive(Deserialize)]
    struct Id {
        id: String,
    }
    resolved
        .workspace
        .and_then(|w| serde_json::from_str::<Id>(w.get()).ok())
        .map(|w| w.id)
        .ok_or_else(|| Failure::new(fill(&record::words().other_version, &[("op", op)])))
}

/// The computer or workspace the read names: `agentsTarget`.
async fn target(client: &Client, asked: &In, tool: &str) -> Result<Value, Failure> {
    let mut target = Map::new();
    match (&asked.workspace, &asked.on) {
        (Some(_), Some(_)) => {
            let words = record::words();
            return Err(Failure::usage(words.both_targets.get(tool).cloned().unwrap_or_default()));
        }
        (Some(workspace), None) => {
            target.insert("workspaceId".to_owned(), Value::from(workspace_id(client, workspace).await?));
        }
        (None, Some(on)) => {
            target.insert("placeId".to_owned(), Value::from(place_named(client, on).await?.0));
        }
        (None, None) => {
            target.insert("placeId".to_owned(), Value::from("here"));
        }
    }
    Ok(Value::Object(target))
}

/// Where a report's shape is not the one this build reads, as the TypeScript tool refuses a parse that throws.
pub(super) fn unread(tool: &str) -> Failure {
    let words = record::words();
    let usage = words.usages.get(tool).map_or("", String::as_str);
    Failure::usage(fill(&words.host_would_not_read, &[("usage", usage)]))
}

async fn call(host: Arc<Host>, arguments: Value, rows: Rows) -> Result<Answer, Refused> {
    let name = rows.name();
    let asked: In = input(name, arguments)?;
    let client = host.client().await?;
    let mut params = Map::new();
    params.insert("target".to_owned(), target(&client, &asked, name).await?);
    let reply = client.request::<Report>("agents.read", params).await?;
    let report = reply.report.ok_or_else(|| unread(name))?;
    let (facts, own) = read(&report, rows, host.cloud()).ok_or_else(|| unread(name))?;
    let text = lines(&facts, &own, rows).ok_or_else(|| unread(name))?.join("\n");
    Ok(match rows {
        Rows::Agents => Answer::text(text, &AgentsOut { facts, agents: own }),
        Rows::Skills => Answer::text(text, &SkillsOut { facts, skills: own }),
        Rows::Servers => Answer::text(text, &ServersOut { facts, servers: own }),
    })
}

/// The report as `AgentsReport.parse` leaves it: every field held to its schema, the three lists each to the schema
/// of the tool that answers it, and the facts and this tool's rows taken out.
fn read(report: &RawValue, rows: Rows, cloud: bool) -> Option<(Facts, Box<RawValue>)> {
    let fields: Ordered = serde_json::from_str(report.get()).ok()?;
    let schemas = Rows::ALL.map(|list| (list, Schema::output_of(entry_in(list.listed(), cloud).unwrap_or_default())));
    let own = &schemas.iter().find(|(list, _)| *list == rows)?.1;
    // Absent is Some(None); a field its schema does not take is None, which is the parse throwing.
    let field = |name: &str, root: &Schema| -> Option<Option<Box<RawValue>>> {
        match fields.get(name) {
            Some(given) => Some(Some(zod::parsed(root.field(name)?, root, given)?)),
            None => Some(None),
        }
    };
    let required = |name: &str, root: &Schema| field(name, root)?;
    let mut mine = None;
    for (list, root) in &schemas {
        let parsed = required(list.name(), root)?;
        if *list == rows {
            mine = Some(parsed);
        }
    }
    field("reach", own)?;
    let text = |raw: Box<RawValue>| serde_json::from_str::<String>(raw.get()).ok();
    let facts = Facts {
        target: required("target", own)?,
        home: text(required("home", own)?)?,
        user: text(required("user", own)?)?,
        read_at: text(required("readAt", own)?)?,
        stale: match field("stale", own)? {
            Some(raw) => Some(text(raw)?),
            None => None,
        },
        refused: serde_json::from_str(required("refused", own)?.get()).ok()?,
        projects: field("projects", own)?,
        reach: None,
    };
    Some((facts, mine?))
}

/// The lines under every list: `reportTail`.
fn tail(facts: &Facts) -> Vec<String> {
    let napping = facts.stale.as_deref() == Some("napping");
    napping
        .then(|| "napping: this is what stood there when it last ran".to_owned())
        .into_iter()
        .chain(facts.refused.iter().map(|line| format!("refused: {}", cell(line))))
        .collect()
}

fn scope_word(scope: &str, project: Option<&Named>) -> String {
    project.map_or_else(|| scope.to_owned(), |p| format!("project {}", cell(&p.name)))
}

fn row(cells: &[&str]) -> Vec<String> {
    cells.iter().map(|c| (*c).to_owned()).collect()
}

/// `agentRowLines`, `skillRowLines` and `serverRowLines`.
fn lines(facts: &Facts, own: &RawValue, rows: Rows) -> Option<Vec<String>> {
    let mut out = match rows {
        Rows::Agents => {
            let agents: Vec<AgentRow> = serde_json::from_str(own.get()).ok()?;
            let word = |a: &AgentRow| match (a.installed, a.sign_in.as_str()) {
                (false, _) => "not found",
                (true, "unknown") => "sign-in unknown",
                (true, "signed-in") => "signed in",
                (true, "vault-key") => "your key",
                (true, _) => "not signed in",
            };
            let mut all = vec![row(&["AGENT", "VERSION", "LATEST", "SIGN-IN", "WSP TOOLS", "PATH"])];
            all.extend(agents.iter().map(|a| {
                let dash = |v: &Option<String>| v.clone().unwrap_or_else(|| "-".to_owned());
                vec![
                    a.name.clone(),
                    dash(&a.version),
                    dash(&a.latest),
                    word(a).to_owned(),
                    (if a.wsp_tools { "yes" } else { "no" }).to_owned(),
                    dash(&a.path),
                ]
            }));
            table(&all)
        }
        Rows::Skills => {
            let skills: Vec<SkillRow> = serde_json::from_str(own.get()).ok()?;
            if skills.is_empty() {
                vec!["no skills".to_owned()]
            } else {
                let place =
                    |p: &SkillPath| p.link_to.as_ref().map_or_else(|| cell(&p.path), |to| format!("{} -> {}", cell(&p.path), cell(to)));
                let mut all = vec![row(&["SKILL", "KIND", "WHERE"])];
                all.extend(skills.iter().map(|s| {
                    vec![cell(&s.name), scope_word(&s.scope, s.project.as_ref()), s.paths.iter().map(place).collect::<Vec<_>>().join(", ")]
                }));
                table(&all)
            }
        }
        Rows::Servers => {
            let servers: Vec<McpRow> = serde_json::from_str(own.get()).ok()?;
            if servers.is_empty() {
                vec!["no MCP servers".to_owned()]
            } else {
                let names = record::words().agent_names;
                let reach = |s: &McpRow| {
                    if s.transport.kind == "stdio" {
                        format!("stdio {}", s.transport.line.as_deref().unwrap_or("undefined"))
                    } else {
                        format!("http {}", s.transport.host.as_deref().unwrap_or("undefined"))
                    }
                };
                let state = |s: &McpRow| {
                    let first = if s.enabled { s.auth.clone() } else { "disabled".to_owned() };
                    if s.in_recipe == Some(false) {
                        format!("{first}, not in recipe")
                    } else {
                        first
                    }
                };
                let mut all = vec![row(&["SERVER", "AGENT", "SCOPE", "REACHED BY", "FILE", "STATE"])];
                all.extend(servers.iter().map(|s| {
                    let agent = names.get(&s.agent).cloned().unwrap_or_else(|| s.agent.clone());
                    vec![s.name.clone(), agent, scope_word(&s.scope, s.project.as_ref()), reach(s), s.file.clone(), state(s)]
                }));
                table(&all)
            }
        }
    };
    out.extend(tail(facts));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<In, AgentsOut>(AGENTS.listed);
        to_the_record::<In, SkillsOut>(SKILLS.listed);
        to_the_record::<In, ServersOut>(SERVERS.listed);
    }
}
