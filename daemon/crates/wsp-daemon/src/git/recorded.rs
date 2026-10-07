// SPDX-License-Identifier: AGPL-3.0-only

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{GitResult, OnThisSide, Runs};
use crate::paths::OpError;

/// One call a way of running was asked to make: where it was to run, the program, its arguments and its stdin.
#[derive(Clone)]
pub(crate) struct Call {
    pub(crate) cwd: String,
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) stdin: Option<Vec<u8>>,
}

pub(crate) struct Recorded {
    pub(crate) calls: Mutex<Vec<Call>>,
    pub(crate) answers: Mutex<Vec<GitResult>>,
    pub(crate) has: Vec<String>,
}

impl Recorded {
    pub(crate) fn new(has: &[&str]) -> Recorded {
        Recorded { calls: Mutex::new(Vec::new()), answers: Mutex::new(Vec::new()), has: has.iter().map(|w| (*w).to_owned()).collect() }
    }

    /// What the next call answers with, in the order they are given.
    pub(crate) fn answering(self, answers: Vec<(i32, &str)>) -> Recorded {
        self.answering_said(answers.into_iter().map(|(code, out)| (code, out, "")).collect())
    }

    /// The same, for the cases that read what a program said on stderr as well as what it exited with.
    pub(crate) fn answering_said(self, answers: Vec<(i32, &str, &str)>) -> Recorded {
        *self.answers.lock().unwrap() = answers
            .into_iter()
            .map(|(code, out, err)| GitResult {
                code: Some(code),
                stdout: out.as_bytes().to_vec(),
                stderr: err.to_owned(),
                truncated: false,
            })
            .collect();
        self
    }

    pub(crate) fn asked(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

impl Runs for Recorded {
    async fn run(
        &self,
        cwd: &Path,
        program: &str,
        args: &[&str],
        input: Option<&[u8]>,
        _max_bytes: Option<usize>,
    ) -> Result<GitResult, OpError> {
        self.calls.lock().unwrap().push(Call {
            cwd: cwd.to_string_lossy().into_owned(),
            program: program.to_owned(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            stdin: input.map(<[u8]>::to_vec),
        });
        let mut answers = self.answers.lock().unwrap();
        Ok(if answers.is_empty() {
            GitResult { code: Some(0), stdout: Vec::new(), stderr: String::new(), truncated: false }
        } else {
            answers.remove(0)
        })
    }

    async fn on_path(&self, program: &str) -> Result<bool, OpError> {
        Ok(self.has.iter().any(|held| held == program))
    }

    fn on_this_side(&self, folder: &Path) -> Option<OnThisSide> {
        Some(OnThisSide { open: folder.to_path_buf(), walk: PathBuf::new() })
    }
}
