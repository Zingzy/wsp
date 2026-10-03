// SPDX-License-Identifier: AGPL-3.0-only
//! A bound daemon ends on SIGTERM however soon after the bind it comes: the binary prints its listening line once
//! bound, and a caller that stops it on that line must not find the signal swallowed. One case in a binary of its
//! own, since the signal goes to the whole process and would end every other daemon running beside it.

use std::io::Write;
use std::time::Duration;

use nix::sys::signal::{raise, Signal};
use wsp_daemon::{Daemon, Options};

#[tokio::test]
async fn a_sigterm_that_lands_between_the_bind_and_the_run_ends_the_daemon() {
    let mut token = tempfile::NamedTempFile::new().unwrap();
    writeln!(token, "terminate-token").unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut options = Options::new(token.path());
    options.readings_interval_ms = Some(86_400_000);
    options.host = "127.0.0.1".to_owned();
    options.port = 0;
    options.root = Some(root.path().to_path_buf());
    options.manifest_path = Some(root.path().join("manifest.json"));
    let daemon = Daemon::bind(options).await.unwrap();
    raise(Signal::SIGTERM).unwrap();
    let ran = tokio::time::timeout(Duration::from_secs(5), daemon.run()).await;
    assert!(matches!(ran, Ok(Ok(()))), "the daemon kept running past the SIGTERM: {ran:?}");
}
