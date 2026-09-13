// SPDX-License-Identifier: AGPL-3.0-only
//! What a computer joined as a place says about itself, the key it proves itself with, and what its leave takes.
//! The report is read off the home the daemon was pointed at and the words it was started with, at every dial
//! rather than once: a laptop gains a Docker, loses a disk and is renamed under wsp rather than by it. Signing and
//! verifying are ed25519-dalek's; the bytes they cover are the protocol's.

use std::path::{Path, PathBuf};

use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest as _, Sha256};
use wsp_frames::{
    numbers, place_daemon_paths, place_owned_paths, words, Base64Bytes, PlaceFile, PlacePublicKey, PlaceReport, PlaceSignature, Platform,
    WorkspaceSize,
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

/// Where the parts of an update are appended while they arrive: under the place's own put folder, named after the
/// upload, so nothing half landed ever sits where the binary the unit starts does.
pub(crate) fn update_part(home: &Path, upload_id: &str) -> PathBuf {
    place_daemon_paths(home).put_dir.join(upload_id)
}

/// One part appended in seq order. Part zero is the one that may find nothing there and the only one that may:
/// anything else is a gap, and the upload is dropped rather than becoming a file with a hole in it.
pub(crate) fn take_update_part(part: &Path, seq: u64, bytes: &[u8], upload_id: &str) -> Result<(), String> {
    let held = std::fs::metadata(part).is_ok();
    if (seq == 0) == held {
        let _ = std::fs::remove_file(part);
        return Err(words::update_out_of_order(seq, upload_id));
    }
    if let Some(parent) = part.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new().append(true).create(true).open(part).map_err(|e| format!("{}: {e}", part.display()))?;
    std::io::Write::write_all(&mut file, bytes).map_err(|e| format!("{}: {e}", part.display()))
}

/// Lowercase hex sha256 of some bytes, as the host spells the one it names on the frame.
fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The file this daemon was execed from, which is the file its unit starts. Linux answers /proc/self/exe with the
/// path and " (deleted)" after it once the inode the process runs has been unlinked, which is what a rename over
/// that path leaves behind: an update that landed and whose daemon has not restarted yet reads its own path that
/// way, and writing to it would make a second file nothing starts.
pub(crate) fn running_daemon(said: std::io::Result<PathBuf>) -> Result<PathBuf, String> {
    let exe = said.map_err(|e| format!("this daemon cannot say which file it runs from: {e}"))?;
    let text = exe.to_string_lossy();
    Ok(match text.strip_suffix(" (deleted)") {
        Some(path) => PathBuf::from(path),
        None => exe,
    })
}

/// The landed binary moved over the one this process runs from, and where the one it replaced was kept. The bytes
/// are checked against the host's sha256 first and the whole of the move is a rename beside the binary, which is
/// the one write a running executable takes: writing into it is refused while it is mapped, and a copy that failed
/// halfway would leave the unit starting a truncated file forever under Restart=always.
pub(crate) fn install_daemon(exe: &Path, part: &Path, sha256: &str, upload_id: &str) -> Result<(String, String), String> {
    let landed = std::fs::read(part).map_err(|e| format!("{}: {e}", part.display()))?;
    let held = sha256_hex(&landed);
    if held != sha256 {
        let _ = std::fs::remove_file(part);
        return Err(words::update_bytes_differ(upload_id, sha256, &held));
    }
    let fresh = exe.with_extension("new");
    let kept = exe.with_extension("old");
    std::fs::write(&fresh, &landed).map_err(|e| format!("{}: {e}", fresh.display()))?;
    std::fs::set_permissions(&fresh, std::os::unix::fs::PermissionsExt::from_mode(0o755))
        .map_err(|e| format!("{}: {e}", fresh.display()))?;
    // The old binary kept beside the new one, so a box whose daemon will not come up still holds the one it ran.
    std::fs::copy(exe, &kept).map_err(|e| format!("{}: {e}", kept.display()))?;
    std::fs::rename(&fresh, exe).map_err(|e| format!("{}: {e}", exe.display()))?;
    let _ = std::fs::remove_file(part);
    Ok((exe.to_string_lossy().into_owned(), kept.to_string_lossy().into_owned()))
}

/// The home the place keeps its files under: --home, else HOME, else the root.
pub(crate) fn place_home(given: Option<&Path>) -> PathBuf {
    given.map(Path::to_path_buf).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use wsp_frames::{place_link_transcript, LinkRole};

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
    fn an_update_appends_its_parts_in_order_and_moves_the_whole_over_the_running_binary() {
        let home = tempfile::tempdir().unwrap();
        let part = update_part(home.path(), "u1");
        assert_eq!(part, place_daemon_paths(home.path()).put_dir.join("u1"));
        // A part that is not the first with nothing there, and a first part with something there, both drop it.
        assert_eq!(take_update_part(&part, 1, b"x", "u1").unwrap_err(), words::update_out_of_order(1, "u1"));
        take_update_part(&part, 0, b"new ", "u1").unwrap();
        assert_eq!(take_update_part(&part, 0, b"x", "u1").unwrap_err(), words::update_out_of_order(0, "u1"));
        take_update_part(&part, 0, b"new ", "u1").unwrap();
        take_update_part(&part, 1, b"daemon", "u1").unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), b"new daemon");

        let exe = home.path().join("wsp-daemon");
        std::fs::write(&exe, b"old daemon").unwrap();
        let wrong = "0".repeat(64);
        let refused = install_daemon(&exe, &part, &wrong, "u1").unwrap_err();
        assert_eq!(refused, words::update_bytes_differ("u1", &wrong, &sha256_hex(b"new daemon")));
        assert_eq!(std::fs::read(&exe).unwrap(), b"old daemon", "a binary whose bytes differ was moved anyway");
        assert!(!part.exists(), "the dropped upload stays on disk");

        take_update_part(&part, 0, b"new daemon", "u1").unwrap();
        let (at, kept) = install_daemon(&exe, &part, &sha256_hex(b"new daemon"), "u1").unwrap();
        assert_eq!(at, exe.to_string_lossy());
        assert_eq!(kept, exe.with_extension("old").to_string_lossy());
        assert_eq!(std::fs::read(&exe).unwrap(), b"new daemon");
        assert_eq!(std::fs::read(exe.with_extension("old")).unwrap(), b"old daemon");
        assert!(!exe.with_extension("new").exists(), "the staged copy stays beside the binary");
        assert!(!part.exists());
        let mode: u32 = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&exe).unwrap().permissions());
        assert_eq!(mode & 0o777, 0o755);
    }

    #[test]
    fn the_binary_this_daemon_runs_is_its_own_path_with_the_kernels_deleted_mark_taken_off() {
        assert_eq!(running_daemon(Ok(PathBuf::from("/h/.wsp/daemon/wsp-daemon"))).unwrap(), PathBuf::from("/h/.wsp/daemon/wsp-daemon"));
        // What /proc/self/exe reads once an update has renamed a new binary over the running one's path.
        assert_eq!(
            running_daemon(Ok(PathBuf::from("/h/.wsp/daemon/wsp-daemon (deleted)"))).unwrap(),
            PathBuf::from("/h/.wsp/daemon/wsp-daemon")
        );
        assert!(running_daemon(Err(std::io::Error::other("no /proc"))).unwrap_err().contains("which file it runs from"));
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
