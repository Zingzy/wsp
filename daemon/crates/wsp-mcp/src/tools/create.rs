// SPDX-License-Identifier: AGPL-3.0-only
//! The tool that makes a workspace: fork, a sibling of a workspace from its image version. The landing is read
//! first, so a computer that forks nothing refuses before anything is minted, then the size is checked against what
//! it offers.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Number, Value};

use super::turn::{self, Picks, TurnOut};
use super::workspace::{self, agents_asked, fmt_rate, js_number, params, quoted_inner, to_fixed, workspace_of};
use super::{input, refused_field, Answer, Refused, Tool};
use crate::client::Client;
use crate::failure::Failure;
use crate::host::Host;
use crate::record::fill;

type Arc<T> = std::sync::Arc<T>;

/// The project a workspace is made for, as far as a create reads it.
#[derive(Deserialize, Clone)]
struct Project {
    id: String,
    name: String,
    computer: String,
}

/// What a create answers with: the workspace, and the notice of anything it did on the way.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct Created {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub workspace: Box<RawValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

async fn project_of(client: &Client, reference: &str) -> Result<Project, Failure> {
    #[derive(Deserialize)]
    struct Resolved {
        project: Project,
    }
    let resolved: Resolved = client.request("projects.resolve", params([("ref", Value::from(reference))])).await?;
    Ok(resolved.project)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Offer {
    cpu: f64,
    mem_mb: f64,
    rate_usd_per_hour: f64,
}

/// The size a --size word names, or nothing when it names none: vCPUs, an x, and memory in GB.
fn size_from_word(word: &str) -> Option<(f64, f64)> {
    let word = word.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (cpu, mem) = word.split_once('x')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mem_ok = match mem.split_once('.') {
        Some((whole, tenths)) => digits(whole) && digits(tenths),
        None => digits(mem),
    };
    if !digits(cpu) || !mem_ok {
        return None;
    }
    let cpu: f64 = cpu.parse().ok()?;
    let mem_mb = (mem.parse::<f64>().ok()? * 1024.0 + 0.5).floor();
    (cpu > 0.0 && mem_mb > 0.0).then_some((cpu, mem_mb))
}

/// A size as the --size flag spells it: vCPUs, an x, memory in GB to a tenth.
fn size_word(offer: &Offer) -> String {
    let gb: f64 = to_fixed(offer.mem_mb / 1024.0, 1).parse().unwrap_or(0.0);
    format!("{}x{}", js_number(offer.cpu), js_number(gb))
}

/// The size refused in the one sentence every road gives, with every size on offer and its rate.
fn size_refused(word: &str, offered: &[Offer]) -> Failure {
    let sizes = offered.iter().map(|o| format!("{} ({})", size_word(o), fmt_rate(o.rate_usd_per_hour))).collect::<Vec<_>>().join(", ");
    let template = workspace::words().size_refused;
    // An empty list leaves the sentence ending where the list would start, and the fix follows its full stop.
    let template = if sizes.is_empty() { template.replace(" {sizes}", "") } else { template };
    Failure::usage(fill(&template, &[("word", word), ("sizes", &sizes)]))
}

struct Asked {
    size: Option<String>,
    agents: Option<Map<String, Value>>,
    parent: Option<String>,
}

fn number(x: f64) -> Value {
    if x.fract() == 0.0 && (0.0..9_007_199_254_740_992.0).contains(&x) {
        Value::from(x as u64)
    } else {
        Number::from_f64(x).map_or(Value::Null, Value::Number)
    }
}

/// A workspace of one project. A project on this computer runs its threads in its own folder and forks nothing, so a
/// size is refused before the landing is read.
async fn create_for(client: &Client, project: &Project, name: &str, asked: Asked) -> Result<Created, Failure> {
    #[derive(Deserialize)]
    struct Capabilities {
        #[serde(default)]
        sizes: Vec<Offer>,
    }
    #[derive(Deserialize)]
    struct Landing {
        capabilities: Capabilities,
    }
    let words = workspace::words();
    if project.computer == words.here_place_id && asked.size.is_some() {
        return Err(Failure::usage(fill(&words.copy_takes_none, &[("project", &project.name), ("words", "--size")])));
    }
    let landing: Landing = client.request("workspaces.landing", params([("project", Value::from(project.id.as_str()))])).await?;
    let chosen = match &asked.size {
        None => None,
        Some(word) => {
            let offered = &landing.capabilities.sizes;
            match size_from_word(word).filter(|(cpu, mem)| offered.iter().any(|o| o.cpu == *cpu && o.mem_mb == *mem)) {
                Some(size) => Some(size),
                None => return Err(size_refused(word, offered)),
            }
        }
    };
    let mut frame = params([("project", Value::from(project.id.as_str())), ("name", Value::from(name))]);
    if let Some((cpu, mem_mb)) = chosen {
        frame.insert("cpu".to_owned(), number(cpu));
        frame.insert("memMb".to_owned(), number(mem_mb));
    }
    if let Some(agents) = asked.agents {
        frame.insert("agents".to_owned(), Value::Object(agents));
    }
    if let Some(parent) = asked.parent {
        frame.insert("parent".to_owned(), Value::from(parent));
    }
    client.request("workspaces.create", frame).await
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ForkIn {
    pub workspace: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub access: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub notify: Option<Vec<String>>,
    #[serde(default)]
    pub spawn: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub max_machines: Option<Number>,
    #[serde(default)]
    #[cfg_attr(test, schemars(with = "Option<u64>"))]
    pub max_depth: Option<Number>,
}

/// A fork's answer: the create's, and with a task the first turn's reply or why it failed.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ForkOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub workspace: Box<RawValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, schemars(with = "Option<serde_json::Value>"))]
    pub turn: Option<TurnOut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

const FORK_NAME: &str = "fork";

const FORK_LISTED: &str = include_str!("../../record/tools/fork.json");

pub const FORK: Tool = Tool { name: FORK_NAME, listed: FORK_LISTED, call: |host, args| Box::pin(fork(host, args)) };

/// A folder named for the thread is refused unless absolute, before anything else: the agent would run a relative
/// one against its own home on the machine and fail there. The task and its picks are checked against the source's
/// machine before anything is minted, since the fork's own agent comes from the image that machine runs.
async fn fork(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ForkIn { workspace, name, size, task, agent, model, effort, access, cwd, notify, spawn, max_machines, max_depth } =
        input(FORK_NAME, arguments)?;
    if let Some(folder) = cwd.as_deref().filter(|f| !f.starts_with('/')) {
        return Err(Failure::usage(fill(&workspace::words().cwd_not_absolute, &[("path", &quoted_inner(folder))])).into());
    }
    let picks = Picks { model, effort, access, fast: None };
    let client = host.client().await?;
    let read = async {
        let source = workspace_of(&client, &workspace).await?;
        if let Some(task) = &task {
            turn::checked_start(&client, task, agent.as_deref(), &picks, Some(&source.id)).await?;
        }
        Ok(source)
    }
    .await;
    // A fork with a task sends a message, and a host that stops under these reads took none.
    let source = if task.is_some() { turn::before_sending(&client, read)? } else { read? };
    let agents = agents_asked(spawn.as_deref(), max_machines.as_ref(), max_depth.as_ref())
        .map_err(|word| refused_field(FORK_NAME, FORK_LISTED, host.cloud(), "spawn", Value::from(word)))?;
    let project = project_of(&client, &source.project.id).await?;
    let name = name.unwrap_or_else(|| format!("{}-fork", source.name));
    let Created { workspace, notice } = create_for(&client, &project, &name, Asked { size, agents, parent: Some(source.id) }).await?;
    let Some(task) = task else { return Ok(Answer::json(&ForkOut { workspace, notice, turn: None, failure: None })) };
    #[derive(Deserialize)]
    struct Made {
        id: String,
        name: String,
    }
    let made: Made = workspace::read(&workspace, "workspaces.create")?;
    let first = async {
        let notify = turn::notify_of(&client, &notify.unwrap_or_default()).await?;
        let mut start = turn::opening(&host, &made.id, &task, agent, cwd.as_deref(), notify);
        picks.wire(&mut start)?;
        turn::follow(&host, client.clone(), &start, &mut None).await
    };
    // The machine was minted before the turn failed; an error that hid it would have the agent fork a second one.
    let failure = match first.await {
        Ok(ended) => match turn::turn_refusal(&ended) {
            None => return Ok(Answer::json(&ForkOut { workspace, notice, turn: Some(turn::turn_out(&ended)), failure: None })),
            Some(failure) => failure.message,
        },
        Err(failed) => failed.message,
    };
    let said = fill(&workspace::words().first_turn_failed, &[("name", &made.name), ("id", &made.id), ("failure", &failure)]);
    Ok(Answer::text_error(said, &ForkOut { workspace, notice, turn: None, failure: Some(failure) }))
}

#[cfg(test)]
mod tests {
    use super::super::held::to_the_record;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        to_the_record::<ForkIn, ForkOut>(FORK.listed);
    }

    #[test]
    fn a_size_word_reads_as_the_protocol_reads_it() {
        assert_eq!(size_from_word(" 2x0.5 "), Some((2.0, 512.0)));
        assert_eq!(size_from_word("2x4"), Some((2.0, 4096.0)));
        for word in ["0x4", "2x0", "2x", "x4", "2x4.", "2x.5", "2 x4", "-2x4", "2x4x"] {
            assert_eq!(size_from_word(word), None, "{word}");
        }
        assert_eq!(size_word(&Offer { cpu: 8.0, mem_mb: 1536.0, rate_usd_per_hour: 0.0 }), "8x1.5");
        assert_eq!(size_word(&Offer { cpu: 4.0, mem_mb: 8192.0, rate_usd_per_hour: 0.0 }), "4x8");
    }
}
