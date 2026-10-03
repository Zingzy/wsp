// SPDX-License-Identifier: AGPL-3.0-only
//! The saved recipes: `recipes` lists them, `recipes_show` reads one with the hash it resolves to here,
//! `recipes_save` saves one off a computer's picks and `recipes_remove` takes one away. Each answers the host's reply
//! in the bytes the host wrote it.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use super::{input, Answer, Refused, Tool};
use crate::host::Host;

type Arc<T> = std::sync::Arc<T>;

pub const LIST: Tool =
    Tool { name: "recipes", listed: include_str!("../../record/tools/recipes.json"), call: |host, args| Box::pin(list(host, args)) };
pub const SHOW: Tool = Tool {
    name: "recipes_show",
    listed: include_str!("../../record/tools/recipes_show.json"),
    call: |host, args| Box::pin(show(host, args)),
};
pub const SAVE: Tool = Tool {
    name: "recipes_save",
    listed: include_str!("../../record/tools/recipes_save.json"),
    call: |host, args| Box::pin(save(host, args)),
};
pub const REMOVE: Tool = Tool {
    name: "recipes_remove",
    listed: include_str!("../../record/tools/recipes_remove.json"),
    call: |host, args| Box::pin(remove(host, args)),
};

#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ListIn {}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ListOut {
    #[cfg_attr(test, schemars(with = "Vec<serde_json::Value>"))]
    pub recipes: Vec<Box<RawValue>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct NameIn {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ShowOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub recipe: Box<RawValue>,
    pub hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct SaveIn {
    pub name: String,
    pub from: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct RecipeOut {
    #[cfg_attr(test, schemars(with = "serde_json::Value"))]
    pub recipe: Box<RawValue>,
}

fn named(name: String) -> Map<String, Value> {
    Map::from_iter([("name".to_owned(), Value::from(name))])
}

async fn list(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let ListIn {} = input("recipes", arguments)?;
    let listed: ListOut = host.client().await?.request("recipes.list", Map::new()).await?;
    Ok(Answer::json(&listed))
}

async fn show(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let NameIn { name } = input("recipes_show", arguments)?;
    let shown: ShowOut = host.client().await?.request("recipes.get", named(name)).await?;
    Ok(Answer::json(&shown))
}

async fn save(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let SaveIn { name, from } = input("recipes_save", arguments)?;
    let mut asked = named(name);
    asked.insert("from".to_owned(), Value::from(from));
    let saved: RecipeOut = host.client().await?.request("recipes.save", asked).await?;
    Ok(Answer::json(&saved))
}

async fn remove(host: Arc<Host>, arguments: Value) -> Result<Answer, Refused> {
    let NameIn { name } = input("recipes_remove", arguments)?;
    let removed: RecipeOut = host.client().await?.request("recipes.remove", named(name)).await?;
    Ok(Answer::json(&removed))
}

#[cfg(test)]
mod tests {
    use super::super::held;
    use super::*;

    #[test]
    fn its_structs_are_the_recorded_schemas() {
        held::to_the_record::<ListIn, ListOut>(LIST.listed);
        held::to_the_record::<NameIn, ShowOut>(SHOW.listed);
        held::to_the_record::<SaveIn, RecipeOut>(SAVE.listed);
        held::to_the_record::<NameIn, RecipeOut>(REMOVE.listed);
    }
}
