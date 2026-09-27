// SPDX-License-Identifier: AGPL-3.0-only
//! A refusal or a failure as the one contract every door answers with: its sentence, and the class the kind stamped on
//! it where it was born belongs to, never read off its words. A tool call answers it as a tool error carrying the
//! failure object; a refusal before the server runs is one line on stderr and the class's exit code.

use serde::Serialize;

use crate::record;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub message: String,
    pub kind: Option<String>,
}

/// The failure object: what --json prints on stderr and a tool error carries beside its text.
#[derive(Debug, Serialize)]
pub struct Object {
    pub error: String,
    pub class: String,
    pub exit: i32,
}

impl Failure {
    /// A failure with no kind, which is the provider's class: the host, the runtime or the machine said no.
    pub fn new(message: impl Into<String>) -> Self {
        Failure { message: message.into(), kind: None }
    }

    pub fn of_kind(message: impl Into<String>, kind: &str) -> Self {
        Failure { message: message.into(), kind: Some(kind.to_owned()) }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Self::of_kind(message, "usage")
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::of_kind(message, "auth")
    }

    pub fn object(&self) -> Object {
        let exit = record::exit();
        let class = self.kind.as_ref().and_then(|kind| exit.kinds.get(kind)).map_or("provider", String::as_str).to_owned();
        let code = exit.codes.get(&class).copied().unwrap_or(1);
        Object { error: self.message.clone(), class, exit: code }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_names_its_class_and_no_kind_is_the_providers() {
        let auth = Failure::auth("no").object();
        assert_eq!((auth.class.as_str(), auth.exit), ("auth", 2));
        let usage = Failure::of_kind("no", "not-found").object();
        assert_eq!((usage.class.as_str(), usage.exit), ("usage", 3));
        for failure in [Failure::new("no"), Failure::of_kind("no", "unreachable")] {
            let provider = failure.object();
            assert_eq!((provider.class.as_str(), provider.exit), ("provider", 1));
        }
    }
}
