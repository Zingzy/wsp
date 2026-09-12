// SPDX-License-Identifier: AGPL-3.0-only
//! The hold a place's file asks for: while `awake` is true this computer is kept out of idle sleep, and the file
//! is read again every two seconds so a toggle written by the app or by wsp lands without a restart. The hold lives
//! here rather than in the app so that quitting the app changes nothing about a computer's sleep.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::place::read_place_file;
use crate::Ctx;

/// How often the file is read; node's watchFile interval on the same file.
const WATCH_EVERY: Duration = Duration::from_secs(2);

/// What holds a computer awake on one platform: the line to run, and the word a log line names it by.
pub(crate) trait Keeper: Send {
    fn words(&self) -> &'static str;
    fn hold(&mut self) -> Result<(), String>;
    fn release(&mut self);
}

/// caffeinate -i -s holds a Mac out of idle sleep and out of system sleep while it is on power; -w ties the hold
/// to this process, so a daemon that dies takes the hold with it.
#[cfg(target_os = "macos")]
struct Caffeinate(Option<std::process::Child>);

#[cfg(target_os = "macos")]
impl Keeper for Caffeinate {
    fn words(&self) -> &'static str {
        "caffeinate"
    }

    fn hold(&mut self) -> Result<(), String> {
        let child = std::process::Command::new("caffeinate")
            .args(["-i", "-s", "-w", &std::process::id().to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        self.0 = Some(child);
        Ok(())
    }

    fn release(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The keeper for this platform, or nothing where wsp knows no way to hold a computer awake.
fn keeper_here() -> Option<Box<dyn Keeper>> {
    #[cfg(target_os = "macos")]
    {
        Some(Box::new(Caffeinate(None)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub(crate) fn no_keeper_line(platform: &str) -> String {
    format!("nothing on {platform} holds this computer awake for wsp; it sleeps on its own schedule while it is joined")
}

pub(crate) fn held_line(words: &str) -> String {
    format!("holding this computer out of idle sleep with {words} while it is joined")
}

pub(crate) fn freed_line(words: &str) -> String {
    format!("let this computer sleep again; the {words} hold is gone")
}

/// The hold as the file asks for it right now, and the line said when it changed.
struct Watch {
    keeper: Option<Box<dyn Keeper>>,
    held: bool,
    said_none: bool,
}

impl Watch {
    fn settle(&mut self, want: bool, log: &dyn Fn(&str)) {
        if want && !self.held {
            let Some(keeper) = self.keeper.as_mut() else {
                if !self.said_none {
                    log(&no_keeper_line(std::env::consts::OS));
                }
                self.said_none = true;
                return;
            };
            match keeper.hold() {
                Ok(()) => {
                    self.held = true;
                    log(&held_line(keeper.words()));
                }
                Err(e) => log(&format!("could not hold this computer awake with {}: {e}", keeper.words())),
            }
        } else if !want && self.held {
            if let Some(keeper) = self.keeper.as_mut() {
                keeper.release();
                log(&freed_line(keeper.words()));
            }
            self.held = false;
        }
    }
}

pub(crate) async fn hold_while_joined(ctx: Arc<Ctx>, file: PathBuf) {
    let mut watch = Watch { keeper: keeper_here(), held: false, said_none: false };
    loop {
        let want = read_place_file(&file).is_some_and(|f| f.awake);
        watch.settle(want, &|line| ctx.log(line));
        tokio::time::sleep(WATCH_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Counting(Arc<Mutex<(u32, u32)>>);

    impl Keeper for Counting {
        fn words(&self) -> &'static str {
            "a fake keeper"
        }
        fn hold(&mut self) -> Result<(), String> {
            self.0.lock().unwrap().0 += 1;
            Ok(())
        }
        fn release(&mut self) {
            self.0.lock().unwrap().1 += 1;
        }
    }

    #[test]
    fn the_hold_is_taken_once_while_asked_for_and_let_go_once_when_not() {
        let counts = Arc::new(Mutex::new((0, 0)));
        let lines = Mutex::new(Vec::new());
        let log = |line: &str| lines.lock().unwrap().push(line.to_owned());
        let mut watch = Watch { keeper: Some(Box::new(Counting(Arc::clone(&counts)))), held: false, said_none: false };
        watch.settle(false, &log);
        assert_eq!(*counts.lock().unwrap(), (0, 0));
        watch.settle(true, &log);
        watch.settle(true, &log);
        assert_eq!(*counts.lock().unwrap(), (1, 0));
        watch.settle(false, &log);
        watch.settle(false, &log);
        assert_eq!(*counts.lock().unwrap(), (1, 1));
        assert_eq!(*lines.lock().unwrap(), vec![held_line("a fake keeper"), freed_line("a fake keeper")]);
    }

    #[test]
    fn a_platform_with_no_keeper_says_so_once() {
        let lines = Mutex::new(Vec::new());
        let log = |line: &str| lines.lock().unwrap().push(line.to_owned());
        let mut watch = Watch { keeper: None, held: false, said_none: false };
        watch.settle(true, &log);
        watch.settle(true, &log);
        watch.settle(false, &log);
        assert_eq!(*lines.lock().unwrap(), vec![no_keeper_line(std::env::consts::OS)]);
    }
}
