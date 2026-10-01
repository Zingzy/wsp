// SPDX-License-Identifier: AGPL-3.0-only
//! `agents_default`, `agents_set`, `agents_setup` and `projects_set`: what a new thread starts on, set per agent and
//! per project on the person's record, and how one agent runs on one computer. Each answers with what now stands, in
//! the TypeScript tools' words, which record/words.json holds under `defaults`.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::agents::{place_named, unread};
use super::named::params;
use super::turn::Picks;
use super::{entry_in, input, Answer, Refused, Tool};
use crate::failure::Failure;
use crate::host::Host;
use crate::record::{self, fill};
use crate::words::cell;
use crate::zod::{self, Ordered, Schema};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Words {
    pub agent_set_nothing: String,
    pub agent_setup_nothing: String,
    pub project_set_nothing: String,
    pub default_agent: String,
    pub starts_own: String,
    pub starts_on: String,
    pub hides: String,
    pub lists_first: String,
    pub adds: String,
    pub env_name: String,
    pub config_absolute: String,
    pub setup_on: String,
    pub setup_off: String,
    pub setup: SetupWords,
    pub sign_in_again: String,
    pub new_threads_head: String,
    pub from: HashMap<String, String>,
    pub no_defaults_answered: String,
    pub labels: Labels,
    pub value_line: String,
}

/// The label each fact of a setup is printed under.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupWords {
    pub program: String,
    pub config_dir: String,
    pub args: String,
    pub env_names: String,
}

/// The word each resolved value is printed under.
#[derive(Deserialize)]
pub struct Labels {
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub access: String,
}

fn words() -> Words {
    record::words().defaults
}

/// What a line calls an agent: its catalog name, else its id.
fn agent_name(id: &str) -> String {
    record::words().agent_names.get(id).cloned().unwrap_or_else(|| id.to_owned())
}

/// A field as a patch carries it: the value named, null where a reset puts it back, absent where neither was said.
fn patched(into: &mut Map<String, Value>, key: &str, value: Option<Value>, reset: bool) {
    match value {
        Some(value) => {
            into.insert(key.to_owned(), value);
        }
        None if reset => {
            into.insert(key.to_owned(), Value::Null);
        }
        None => {}
    }
}

/// wsp's access word, refused where it is none of the four.
fn access_word(access: Option<String>) -> Result<Option<String>, Failure> {
    Ok(Picks { access, ..Picks::default() }.access_word()?.map(str::to_owned))
}

/// A reply the tool answers only once it has been set; what the host says of it is not read.
#[derive(Deserialize)]
struct Set {}

/// The value a TypeScript tool's zod parse leaves of one field of its answer, off the recorded output schema.
fn parsed(listed: &str, cloud: bool, field: &str, given: &RawValue) -> Option<Box<RawValue>> {
    let root = Schema::output_of(entry_in(listed, cloud).unwrap_or_default());
    zod::parsed(root.field(field)?, &root, given)
}

const DEFAULT_NAME: &str = "agents_default";
const DEFAULT_LISTED: &str = include_str!("../../record/tools/agents_default.json");

pub const DEFAULT: Tool = Tool { name: DEFAULT_NAME, listed: DEFAULT_LISTED, call: |host, args| Box::pin(agents_default(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct DefaultIn {
    pub agent: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DefaultOut {
    pub default_agent: String,
}

async fn agents_default(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let DefaultIn { agent } = input(DEFAULT_NAME, arguments)?;
    let client = host.client().await?;
    let patch = params([("defaultAgent", Value::from(agent.as_str()))]);
    client.request::<Set>("preferences.set", params([("patch", Value::Object(patch))])).await?;
    Ok(Answer::text(fill(&words().default_agent, &[("agent", &agent_name(&agent))]), &DefaultOut { default_agent: agent }))
}

const SET_NAME: &str = "agents_set";
const SET_LISTED: &str = include_str!("../../record/tools/agents_set.json");

pub const SET: Tool = Tool { name: SET_NAME, listed: SET_LISTED, call: |host, args| Box::pin(agents_set(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SetIn {
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub access: Option<String>,
    #[serde(default)]
    pub hide: Option<Vec<String>>,
    #[serde(default)]
    pub show: Option<Vec<String>>,
    #[serde(default)]
    pub order: Option<Vec<String>>,
    #[serde(default)]
    pub add_model: Option<Vec<String>>,
    #[serde(default)]
    pub drop_model: Option<Vec<String>>,
    #[serde(default)]
    pub reset: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SetOut {
    pub agent: String,
    #[cfg_attr(test, schemars(with = "std::collections::BTreeMap<String, serde_json::Value>"))]
    pub defaults: Box<RawValue>,
}

/// One agent's model picker as the person's record keeps it.
#[derive(Default, Deserialize)]
struct Picker {
    #[serde(default)]
    hide: Vec<String>,
    #[serde(default)]
    order: Vec<String>,
    #[serde(default)]
    custom: Vec<String>,
}

/// One agent's defaults as the answer reads them.
#[derive(Default, Deserialize)]
struct Defaults {
    model: Option<String>,
    effort: Option<String>,
    access: Option<String>,
    models: Option<Picker>,
}

/// The list in order with each value once, its first place kept, as a JavaScript Set keeps it.
fn once(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for value in values {
        if !kept.contains(&value) {
            kept.push(value);
        }
    }
    kept
}

/// One agent's defaults in a field of the person's record, as the reply carries it.
fn agent_defaults(preferences: &RawValue, agent: &str) -> Option<Box<RawValue>> {
    let record: Ordered = serde_json::from_str(preferences.get()).ok()?;
    let by_agent: Ordered = serde_json::from_str(record.get("agentDefaults")?.get()).ok()?;
    by_agent.get(agent).map(RawValue::to_owned)
}

/// What one agent's defaults now read as, in one line: `agentDefaultsLine`.
fn defaults_line(agent: &str, d: &Defaults) -> String {
    let w = words();
    let listed = |models: &[String], template: &str| (!models.is_empty()).then(|| fill(template, &[("models", &models.join(" "))]));
    let picker = d
        .models
        .as_ref()
        .map_or_else(Vec::new, |m| vec![listed(&m.hide, &w.hides), listed(&m.order, &w.lists_first), listed(&m.custom, &w.adds)]);
    let said: Vec<String> = [d.model.clone(), d.effort.clone(), d.access.clone()].into_iter().chain(picker).flatten().collect();
    let name = agent_name(agent);
    if said.is_empty() {
        fill(&w.starts_own, &[("agent", &name)])
    } else {
        fill(&w.starts_on, &[("agent", &name), ("said", &said.join("; "))])
    }
}

async fn agents_set(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let SetIn { agent, model, effort, access, hide, show, order, add_model, drop_model, reset } = input(SET_NAME, arguments)?;
    let reset = reset.unwrap_or_default();
    let resets = |field: &str| reset.iter().any(|r| r == field);
    let [hide, show, order, add_model, drop_model] = [hide, show, order, add_model, drop_model].map(Option::unwrap_or_default);
    let client = host.client().await?;
    let lists = [&hide, &show, &order, &add_model, &drop_model].iter().any(|l| !l.is_empty());
    let models = if resets("models") {
        Some(Value::Null)
    } else if lists {
        #[derive(Deserialize)]
        struct Got {
            preferences: Box<RawValue>,
        }
        let got: Got = client.request("preferences.get", Map::new()).await?;
        let kept: Picker = agent_defaults(&got.preferences, &agent)
            .and_then(|raw| serde_json::from_str::<Defaults>(raw.get()).ok())
            .and_then(|d| d.models)
            .unwrap_or_default();
        let hide = once(kept.hide.into_iter().filter(|m| !show.contains(m)).chain(hide.iter().cloned()));
        let custom = once(kept.custom.into_iter().filter(|m| !drop_model.contains(m)).chain(add_model.iter().cloned()));
        let order = if order.is_empty() { kept.order } else { order.clone() };
        let mut picker = Map::new();
        for (key, list) in [("hide", hide), ("order", order), ("custom", custom)] {
            if !list.is_empty() {
                picker.insert(key.to_owned(), Value::from(list));
            }
        }
        Some(Value::Object(picker))
    } else {
        None
    };
    let mut patch = Map::new();
    patched(&mut patch, "model", model.map(Value::from), resets("model"));
    patched(&mut patch, "effort", effort.map(Value::from), resets("effort"));
    patched(&mut patch, "access", access_word(access)?.map(Value::from), resets("access"));
    if let Some(models) = models {
        patch.insert("models".to_owned(), models);
    }
    if patch.is_empty() {
        return Err(Failure::usage(words().agent_set_nothing).into());
    }
    #[derive(Deserialize)]
    struct Kept {
        preferences: Box<RawValue>,
    }
    let by_agent = params([(agent.as_str(), Value::Object(patch))]);
    let kept: Kept =
        client.request("preferences.set", params([("patch", Value::Object(params([("agentDefaults", Value::Object(by_agent))])))])).await?;
    let defaults = match agent_defaults(&kept.preferences, &agent) {
        Some(given) => parsed(SET_LISTED, host.cloud(), "defaults", &given).ok_or_else(|| unread(SET_NAME))?,
        None => RawValue::from_string("{}".to_owned()).map_err(|_| unread(SET_NAME))?,
    };
    let read: Defaults = serde_json::from_str(defaults.get()).map_err(|_| unread(SET_NAME))?;
    Ok(Answer::text(defaults_line(&agent, &read), &SetOut { agent, defaults }))
}

const SETUP_NAME: &str = "agents_setup";
const SETUP_LISTED: &str = include_str!("../../record/tools/agents_setup.json");

pub const SETUP: Tool = Tool { name: SETUP_NAME, listed: SETUP_LISTED, call: |host, args| Box::pin(agents_setup(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SetupIn {
    pub agent: String,
    #[serde(default)]
    pub on: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub config: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub unset_env: Option<Vec<String>>,
    #[serde(default)]
    pub reset: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SetupOut {
    #[cfg_attr(test, schemars(with = "std::collections::BTreeMap<String, serde_json::Value>"))]
    pub agent: Box<RawValue>,
}

/// How an agent runs there, as its row carries it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupView {
    on: bool,
    program: Option<String>,
    config_dir: Option<String>,
    args: Option<Vec<String>>,
    env_names: Vec<String>,
}

#[derive(Deserialize)]
struct SetupRow {
    name: String,
    setup: Option<SetupView>,
}

/// A variable's name a shell reads as one: a letter or _ first, then letters, digits and _.
fn env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A value as JSON.stringify quotes it, for a refusal that names what it was given.
fn quoted(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// How an agent now runs there, one fact a line, with the sign-in a moved config folder asks for: `agentSetupLines`.
fn setup_lines(row: &SetupRow, config_moved: bool) -> Vec<String> {
    let w = words();
    let setup = row.setup.as_ref();
    let on = setup.is_none_or(|s| s.on);
    let mut lines = vec![fill(if on { &w.setup_on } else { &w.setup_off }, &[("name", &row.name)])];
    if let Some(setup) = setup {
        if let Some(program) = &setup.program {
            lines.push(format!("{}: {}", w.setup.program, cell(program)));
        }
        if let Some(dir) = &setup.config_dir {
            lines.push(format!("{}: {}", w.setup.config_dir, cell(dir)));
        }
        if let Some(args) = &setup.args {
            lines.push(format!("{}: {}", w.setup.args, args.iter().map(|a| cell(a)).collect::<Vec<_>>().join(" ")));
        }
        if !setup.env_names.is_empty() {
            lines.push(format!("{}: {}", w.setup.env_names, setup.env_names.join(" ")));
        }
        if config_moved && setup.config_dir.is_some() {
            lines.push(fill(&w.sign_in_again, &[("agent", &row.name)]));
        }
    }
    lines
}

async fn agents_setup(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let SetupIn { agent, on, enabled, program, config, args, unset_env, reset } = input(SETUP_NAME, arguments)?;
    let reset = reset.unwrap_or_default();
    let resets = |field: &str| reset.iter().any(|r| r == field);
    let client = host.client().await?;
    let place = match &on {
        Some(on) => place_named(&client, on).await?.0,
        None => record::words().here_place_id,
    };
    let w = words();
    let mut env = Map::new();
    for name in unset_env.unwrap_or_default() {
        if !env_name(&name) {
            return Err(Failure::usage(fill(&w.env_name, &[("named", "--unset-env"), ("quoted", &quoted(&name))])).into());
        }
        env.insert(name, Value::Null);
    }
    let config_moved = config.is_some();
    if let Some(dir) = config.as_deref().filter(|dir| !dir.starts_with('/')) {
        return Err(Failure::usage(fill(&w.config_absolute, &[("quoted", &quoted(dir))])).into());
    }
    let mut change = Map::new();
    if let Some(enabled) = enabled {
        change.insert("on".to_owned(), Value::from(enabled));
    }
    patched(&mut change, "program", program.map(Value::from), resets("program"));
    patched(&mut change, "configDir", config.map(Value::from), resets("config"));
    patched(&mut change, "args", args.filter(|a| !a.is_empty()).map(Value::from), resets("args"));
    if !env.is_empty() {
        change.insert("env".to_owned(), Value::Object(env));
    }
    if change.is_empty() {
        return Err(Failure::usage(w.agent_setup_nothing).into());
    }
    let mut asked = params([("placeId", Value::from(place)), ("agent", Value::from(agent.as_str()))]);
    asked.extend(change);
    #[derive(Deserialize)]
    struct Answered {
        agent: Option<Box<RawValue>>,
    }
    let answered: Answered = client.request("agents.setup", asked).await?;
    let row = answered.agent.and_then(|given| parsed(SETUP_LISTED, host.cloud(), "agent", &given)).ok_or_else(|| unread(SETUP_NAME))?;
    let read: SetupRow = serde_json::from_str(row.get()).map_err(|_| unread(SETUP_NAME))?;
    Ok(Answer::text(setup_lines(&read, config_moved).join("\n"), &SetupOut { agent: row }))
}

const PROJECT_NAME: &str = "projects_set";
const PROJECT_LISTED: &str = include_str!("../../record/tools/projects_set.json");

pub const PROJECT: Tool = Tool { name: PROJECT_NAME, listed: PROJECT_LISTED, call: |host, args| Box::pin(projects_set(host, args)) };

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ProjectIn {
    pub project: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub access: Option<String>,
    #[serde(default)]
    pub reset: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ProjectOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub project: Box<RawValue>,
    #[cfg_attr(test, schemars(with = "std::collections::BTreeMap<String, serde_json::Value>"))]
    pub defaults: Box<RawValue>,
}

/// One resolved value and where it came from.
#[derive(Deserialize)]
struct Pick {
    value: String,
    from: String,
}

#[derive(Deserialize)]
struct Resolved {
    agent: Pick,
    model: Option<Pick>,
    effort: Option<Pick>,
    access: Option<Pick>,
}

/// What a new thread on a project starts on, one value a line, each with where it came from: `threadDefaultsLines`.
fn defaults_lines(d: &Resolved) -> Vec<String> {
    let w = words();
    let line = |label: &str, pick: &Pick, shown: &str| {
        let from = w.from.get(&pick.from).cloned().unwrap_or_default();
        fill(&w.value_line, &[("label", label), ("value", shown), ("from", &from)])
    };
    let mut lines = vec![line(&w.labels.agent, &d.agent, &agent_name(&d.agent.value))];
    for (label, pick) in [(&w.labels.model, &d.model), (&w.labels.effort, &d.effort), (&w.labels.access, &d.access)] {
        if let Some(pick) = pick {
            lines.push(line(label, pick, &pick.value));
        }
    }
    lines
}

async fn projects_set(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ProjectIn { project, agent, model, effort, access, reset } = input(PROJECT_NAME, arguments)?;
    let reset = reset.unwrap_or_default();
    let resets = |field: &str| reset.iter().any(|r| r == field);
    let client = host.client().await?;
    let mut patch = Map::new();
    patched(&mut patch, "agent", agent.map(Value::from), resets("agent"));
    patched(&mut patch, "model", model.map(Value::from), resets("model"));
    patched(&mut patch, "effort", effort.map(Value::from), resets("effort"));
    patched(&mut patch, "access", access_word(access)?.map(Value::from), resets("access"));
    if patch.is_empty() {
        return Err(Failure::usage(words().project_set_nothing).into());
    }
    #[derive(Deserialize)]
    struct Found {
        project: Box<RawValue>,
    }
    #[derive(Deserialize)]
    struct Named {
        id: String,
        name: String,
    }
    let found: Found = client.request("projects.resolve", params([("ref", Value::from(project))])).await?;
    let named: Named = serde_json::from_str(found.project.get()).map_err(|_| unread(PROJECT_NAME))?;
    let by_project = params([(named.id.as_str(), Value::Object(patch))]);
    client
        .request::<Set>("preferences.set", params([("patch", Value::Object(params([("projectDefaults", Value::Object(by_project))])))]))
        .await?;
    #[derive(Deserialize)]
    struct Answered {
        defaults: Option<Box<RawValue>>,
    }
    let answered: Answered = client.request("projects.defaults", Map::new()).await?;
    let all: Ordered = answered.defaults.and_then(|raw| serde_json::from_str(raw.get()).ok()).ok_or_else(|| unread(PROJECT_NAME))?;
    let Some(given) = all.get(&named.id) else {
        return Err(Failure::new(fill(&words().no_defaults_answered, &[("project", &named.name)])).into());
    };
    let defaults = parsed(PROJECT_LISTED, host.cloud(), "defaults", given).ok_or_else(|| unread(PROJECT_NAME))?;
    let read: Resolved = serde_json::from_str(defaults.get()).map_err(|_| unread(PROJECT_NAME))?;
    let head = fill(&words().new_threads_head, &[("project", &named.name)]);
    let text = std::iter::once(head).chain(defaults_lines(&read)).collect::<Vec<_>>().join("\n");
    Ok(Answer::text(text, &ProjectOut { project: found.project, defaults }))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<DefaultIn, DefaultOut>(DEFAULT.listed);
        to_the_record::<SetIn, SetOut>(SET.listed);
        to_the_record::<SetupIn, SetupOut>(SETUP.listed);
        to_the_record::<ProjectIn, ProjectOut>(PROJECT.listed);
    }
}
