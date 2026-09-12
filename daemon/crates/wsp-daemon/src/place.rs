// SPDX-License-Identifier: AGPL-3.0-only
//! What a computer joined as a place says about itself, the key it proves itself with, and what its leave takes.
//! The report is read off the home the daemon was pointed at and the words it was started with, at every dial
//! rather than once: a laptop gains a Docker, loses a disk and is renamed under wsp rather than by it. Signing and
//! verifying are ed25519-dalek's; the bytes they cover are the protocol's.

use std::path::{Path, PathBuf};

use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use wsp_frames::{
    numbers, place_owned_paths, Base64Bytes, PlaceFile, PlacePublicKey, PlaceReport, PlaceSignature, Platform, WorkspaceSize,
};
use wsp_runtime::doctor::on_path;

/// The place file as it stands, or nothing when this computer is no place: a file that is there and is not one
/// reads the same as none, since the one road that writes it is wsp join.
pub(crate) fn read_place_file(path: &Path) -> Option<PlaceFile> {
    PlaceFile::parse(&std::fs::read_to_string(path).ok()?)
}

/// This place's signature over the transcript, with the pkcs8 PEM key wsp join wrote.
pub(crate) fn sign_place_bytes(private_key_pem: &str, bytes: &[u8]) -> Result<PlaceSignature, String> {
    let key = SigningKey::from_pkcs8_pem(private_key_pem).map_err(|e| format!("the place key does not read as pkcs8 PEM: {e}"))?;
    Ok(Base64Bytes::from_bytes(&key.sign(bytes).to_bytes()))
}

/// Whether the key given (SPKI DER, base64) made this signature over these bytes. A key that will not parse is a
/// refusal rather than a failure: the answer came off the wire.
pub(crate) fn verify_place_bytes(public_key: &PlacePublicKey, bytes: &[u8], signature: &PlaceSignature) -> bool {
    let Ok(key) = VerifyingKey::from_public_key_der(&public_key.to_bytes()) else { return false };
    key.verify(bytes, &Signature::from_bytes(&signature.to_bytes())).is_ok()
}

/// One agent to look for on this computer, as the --agents flag spells it: the catalog id and the command name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentBin {
    pub(crate) id: String,
    pub(crate) bin: String,
}

/// `id=command` pairs; a pair missing either half is dropped, since the report has nothing to look for.
pub(crate) fn parse_agents(words: &[String]) -> Vec<AgentBin> {
    words
        .iter()
        .filter_map(|word| {
            let (id, bin) = word.split_once('=')?;
            (!id.is_empty() && !bin.is_empty()).then(|| AgentBin { id: id.to_owned(), bin: bin.to_owned() })
        })
        .collect()
}

/// How much room is left on the volume the folder sits on, or nothing when this computer will not say.
fn disk_free(folder: &Path) -> Option<u64> {
    let fs = nix::sys::statfs::statfs(folder).ok()?;
    Some(fs.blocks_available() * u64::try_from(fs.block_size()).ok()?)
}

/// node's os.arch() words for the machines wsp runs on; anything else travels as Rust names it.
fn arch_word() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        other => other,
    }
    .to_owned()
}

#[cfg(target_os = "linux")]
fn total_memory_bytes() -> u64 {
    nix::sys::sysinfo::sysinfo().map(|s| s.ram_total()).unwrap_or(0)
}

#[cfg(not(target_os = "linux"))]
fn total_memory_bytes() -> u64 {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|out| String::from_utf8_lossy(&out.stdout).trim().parse().ok())
        .unwrap_or(0)
}

fn os_line() -> String {
    match nix::sys::utsname::uname() {
        Ok(u) => format!("{} {}", u.sysname().to_string_lossy(), u.release().to_string_lossy()),
        Err(_) => std::env::consts::OS.to_owned(),
    }
}

fn user_name() -> String {
    nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|u| u.name)
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_default()
}

/// What this report is built from: the file, the home, the words the daemon was started with.
pub(crate) struct ReportInput<'a> {
    pub(crate) file: &'a PlaceFile,
    pub(crate) home: &'a Path,
    pub(crate) wsp_argv: &'a [String],
    pub(crate) agents: &'a [AgentBin],
    pub(crate) daemon_port: u16,
    pub(crate) dialed: &'a str,
}

/// What this computer says about itself on this link, in the shape the host parses.
pub(crate) fn place_report(input: &ReportInput<'_>) -> PlaceReport {
    let path = std::env::var("PATH").unwrap_or_default();
    let work = input.home.join("wsp-work");
    let free = disk_free(if work.exists() { &work } else { input.home });
    let wsp = if input.wsp_argv.is_empty() { vec!["wsp".to_owned()] } else { input.wsp_argv.to_vec() };
    let doctor = wsp_runtime::doctor::assess(&wsp_runtime::doctor::read_facts());
    PlaceReport {
        name: input.file.name.clone(),
        platform: if cfg!(target_os = "macos") { Platform::Darwin } else { Platform::Linux },
        arch: arch_word(),
        os: os_line(),
        shape: WorkspaceSize {
            cpu: std::thread::available_parallelism().map_or(1.0, |n| n.get() as f64),
            mem_mb: (total_memory_bytes() as f64 / (1024.0 * 1024.0)).round() as u64,
        },
        disk_free_bytes: free,
        login: [
            ("HOME".to_owned(), input.home.to_string_lossy().into_owned()),
            ("USER".to_owned(), user_name()),
            ("PATH".to_owned(), path.clone()),
        ]
        .into_iter()
        .collect(),
        runs_workspaces: doctor.runs_workspaces,
        workspaces_blocked: doctor.blocked,
        engine: doctor.engine.word().to_owned(),
        daemon_version: numbers::DAEMON_VERSION,
        daemon_port: std::num::NonZeroU16::new(input.daemon_port),
        wsp,
        dialed: input.dialed.to_owned(),
        agents: input.agents.iter().filter(|a| on_path(&a.bin, &path)).map(|a| a.id.clone()).collect(),
    }
}

/// Takes wsp off this computer, by the one list the protocol names, and answers what went. A path is there when it
/// exists as a link or a file, since the browser name is a symlink whose target may already be gone.
pub(crate) fn sweep_place_home(home: &Path) -> Vec<String> {
    let mut removed = Vec::new();
    for path in place_owned_paths(home) {
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        let gone = if meta.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        if gone.is_ok() {
            removed.push(path.to_string_lossy().into_owned());
        }
    }
    removed
}

/// The home the place keeps its files under: --home, else HOME, else the root.
pub(crate) fn place_home(given: Option<&Path>) -> PathBuf {
    given.map(Path::to_path_buf).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use wsp_frames::{place_daemon_paths, place_link_transcript, LinkRole};

    fn pair() -> (String, PlacePublicKey) {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        let key = SigningKey::from_bytes(&seed);
        let der = key.verifying_key().to_public_key_der().unwrap();
        let public = Base64Bytes::parse(&base64::Engine::encode(&base64::engine::general_purpose::STANDARD, der.as_bytes())).unwrap();
        (key.to_pkcs8_pem(ed25519_dalek::pkcs8::spki::der::pem::LineEnding::LF).unwrap().to_string(), public)
    }

    #[test]
    fn a_signature_verifies_under_its_own_key_and_no_other_over_no_other_bytes() {
        let (pem, public) = pair();
        let (_, other) = pair();
        let bytes = place_link_transcript(LinkRole::Place, "p_1", "AAA=", "BBB=");
        let sig = sign_place_bytes(&pem, &bytes).unwrap();
        assert!(verify_place_bytes(&public, &bytes, &sig));
        assert!(!verify_place_bytes(&other, &bytes, &sig));
        assert!(!verify_place_bytes(&public, &place_link_transcript(LinkRole::Host, "p_1", "AAA=", "BBB="), &sig));
        assert!(sign_place_bytes("not a key", &bytes).is_err());
    }

    #[test]
    fn signing_matches_the_node_side_byte_for_byte() {
        let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/place-link-signing.json")).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&text).unwrap();
        let s = |k: &str| fixture[k].as_str().unwrap().to_owned();
        let b64 = |k: &str| base64::Engine::decode(&base64::engine::general_purpose::STANDARD, s(k)).unwrap();
        let host_bytes = place_link_transcript(LinkRole::Host, &s("placeId"), &s("placeNonce"), &s("hostNonce"));
        let place_bytes = place_link_transcript(LinkRole::Place, &s("placeId"), &s("hostNonce"), &s("placeNonce"));
        assert_eq!(host_bytes, b64("hostTranscript"));
        assert_eq!(place_bytes, b64("placeTranscript"));
        let public = Base64Bytes::parse(&s("publicKey")).unwrap();
        assert_eq!(sign_place_bytes(&s("privateKeyPem"), &host_bytes).unwrap().as_str(), s("hostSignature"));
        assert_eq!(sign_place_bytes(&s("privateKeyPem"), &place_bytes).unwrap().as_str(), s("placeSignature"));
        assert!(verify_place_bytes(&public, &place_bytes, &Base64Bytes::parse(&s("placeSignature")).unwrap()));
    }

    #[test]
    fn agents_are_id_command_pairs_and_only_those_on_path_are_reported() {
        assert_eq!(
            parse_agents(&["a1=sh".to_owned(), "broken".to_owned(), "=x".to_owned(), "b2=no-such-agent-command".to_owned()]).len(),
            2
        );
        assert!(on_path("sh", "/nonexistent:/bin:/usr/bin"));
        assert!(!on_path("no-such-agent-command", "/bin:/usr/bin"));
        assert!(!on_path("sh", ""));
    }

    #[test]
    fn the_report_is_read_off_the_home_and_the_words_given() {
        let home = tempfile::tempdir().unwrap();
        let file = PlaceFile::parse(
            r#"{"placeId":"p","name":"old-macbook","hostName":"h","hostUrls":[],"hostPublicKey":"k","keyPath":"/k","awake":false}"#,
        )
        .unwrap();
        let agents = parse_agents(&["a1=sh".to_owned(), "b2=no-such-agent-command".to_owned()]);
        let argv = ["/usr/local/bin/node".to_owned(), "/opt/wsp/bin.js".to_owned()];
        let report = place_report(&ReportInput {
            file: &file,
            home: home.path(),
            wsp_argv: &argv,
            agents: &agents,
            daemon_port: 4321,
            dialed: "http://h:1",
        });
        assert_eq!(report.name, "old-macbook");
        assert_eq!(report.wsp, argv);
        assert_eq!(report.agents, vec!["a1"]);
        assert_eq!(report.login["HOME"], home.path().to_string_lossy());
        assert_eq!(report.daemon_port.map(|p| p.get()), Some(4321));
        assert_eq!(report.dialed, "http://h:1");
        assert!(report.shape.cpu > 0.0 && report.shape.mem_mb > 0);
        assert!(report.disk_free_bytes.is_some());
        assert_eq!(report.daemon_version, numbers::DAEMON_VERSION);
        // runs_workspaces and engine are the doctor's reading of this box; on this Linux test box it runs them.
        assert_eq!(report.engine, wsp_runtime::doctor::engine_on_path(&std::env::var("PATH").unwrap_or_default()).word());
        let bare =
            place_report(&ReportInput { file: &file, home: home.path(), wsp_argv: &[], agents: &[], daemon_port: 1, dialed: "http://h:1" });
        assert_eq!(bare.wsp, vec!["wsp"]);
        // The shape the host parses is the shape this serialises to.
        serde_json::from_value::<PlaceReport>(serde_json::to_value(&report).unwrap()).unwrap();
    }

    #[test]
    fn the_sweep_takes_what_is_there_in_the_protocols_order_and_leaves_the_work_folder() {
        let home = tempfile::tempdir().unwrap();
        let at = place_daemon_paths(home.path());
        std::fs::create_dir_all(&at.wsp).unwrap();
        std::fs::create_dir_all(&at.bin_dir).unwrap();
        std::fs::write(&at.token_path, "t\n").unwrap();
        std::fs::write(&at.place_key, "k").unwrap();
        std::fs::write(&at.place_file, "{}").unwrap();
        std::fs::create_dir_all(at.dir.join("inner")).unwrap();
        std::os::unix::fs::symlink("/nonexistent/wsp-open", at.bin_dir.join("xdg-open")).unwrap();
        let work = home.path().join("wsp-work");
        std::fs::create_dir_all(&work).unwrap();
        let swept = sweep_place_home(home.path());
        let names: Vec<_> = [&at.place_file, &at.place_key, &at.dir, &at.token_path, &at.bin_dir.join("xdg-open")]
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(swept, names);
        for path in [&at.place_file, &at.place_key, &at.dir, &at.token_path] {
            assert!(!path.exists(), "{}", path.display());
        }
        assert!(std::fs::symlink_metadata(at.bin_dir.join("xdg-open")).is_err());
        assert!(work.exists());
        assert!(sweep_place_home(home.path()).is_empty());
    }
}
