// SPDX-License-Identifier: AGPL-3.0-only
//! The store fed by a registry the test serves itself: an OCI layout on disk behind a small HTTP server that
//! hands out a token, redirects blobs to a second listener, answers ranges, and can be told to corrupt a blob,
//! cut one short, stall one, or refuse its own token.

mod registry;

use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::time::{Duration, Instant};

use registry::{Layout, Server};
use wsp_runtime::fetch::{self, Client, Digest, Reference};
use wsp_runtime::store::{self, Chain, Store};

const IMAGE: &str = "ubuntu:24.04";

/// Two images that share a layer: `ubuntu:24.04` is base then os-release, `tools:1` is os-release then tools.
struct World {
    layout: Layout,
    server: Server,
    base: Digest,
    os_release: Digest,
    tools: Digest,
}

fn world() -> World {
    let mut layout = Layout::new();
    let base = layout.layer(&[
        ("bin/", b"", 0o755, 0),
        ("bin/sh", &noise(20_000, 7), 0o755, 0),
        ("etc/", b"", 0o755, 0),
        ("usr/bin/passwd", &noise(300, 9), 0o4755, 0),
        ("home/agent/.profile", b"export PS1='$ '\n", 0o644, 1000),
    ]);
    let os_release = layout.layer(&[("etc/os-release", b"PRETTY_NAME=\"Ubuntu 24.04\"\n", 0o644, 0)]);
    let tools = layout.layer(&[("usr/bin/redis-cli", &noise(5_000, 3), 0o755, 0)]);
    layout.image("ubuntu", "24.04", &[base.clone(), os_release.clone()]);
    layout.image("tools", "1", &[os_release.clone(), tools.clone()]);
    let server = Server::start(layout.dir().to_path_buf());
    World { layout, server, base, os_release, tools }
}

/// Bytes gzip cannot fold away, so a layer is big enough to cut in the middle.
fn noise(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x & 0xff) as u8
        })
        .collect()
}

fn source(server: &Server, repository: &str, tag: &str) -> Reference {
    Reference { registry: format!("http://{}", server.addr), repository: repository.to_owned(), reference: tag.to_owned() }
}

#[test]
fn pulls_the_image_from_the_test_registry_with_every_digest_verified() {
    let w = world();
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();

    let pulled = store.pull(IMAGE, &source(&w.server, "ubuntu", "24.04"), &mut Client::new()).unwrap();
    assert!(pulled.fetched);
    let image = pulled.image;
    assert_eq!(image.name, IMAGE);
    assert_eq!(image.chain.layers, vec![w.base.clone(), w.os_release.clone()]);
    assert_eq!(image.manifest, w.layout.manifest_digest("ubuntu", "24.04"));
    assert_eq!(image.chain.config, w.layout.config_digest("ubuntu", "24.04"));
    assert_eq!(store.image(IMAGE).unwrap(), Some(image.clone()));

    for digest in image.chain.layers.iter().chain(std::iter::once(&image.chain.config)) {
        assert!(store.has_blob(digest), "{digest} landed");
    }
    let base = store.unpacked(&w.base).expect("the base layer unpacked");
    assert_eq!(std::fs::metadata(base.join("bin/sh")).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(std::fs::read(base.join("bin/sh")).unwrap(), noise(20_000, 7));
    assert_eq!(std::fs::metadata(base.join("usr/bin/passwd")).unwrap().permissions().mode() & 0o7777, 0o4755, "setuid survives");
    let me = std::fs::metadata(root.path()).unwrap().uid();
    let owner = std::fs::metadata(base.join("home/agent/.profile")).unwrap().uid();
    assert_eq!(owner, if me == 0 { 1000 } else { me }, "owners land as root, stay ours otherwise");
    let os_release = store.unpacked(&w.os_release).expect("the os-release layer unpacked");
    assert_eq!(std::fs::read_to_string(os_release.join("etc/os-release")).unwrap(), "PRETTY_NAME=\"Ubuntu 24.04\"\n");
    assert_eq!(store.unpacked(&w.tools), None);

    let log = w.server.log();
    assert_eq!(log.iter().filter(|l| l.starts_with("GET /token?service=test-registry&scope=repository:ubuntu:pull ")).count(), 1);
    assert_eq!(log.iter().filter(|l| l.contains("/manifests/")).count(), 3, "{log:#?}");
    assert!(log.iter().any(|l| l.starts_with("GET /v2/ubuntu/manifests/24.04 ") && l.ends_with("-> 200")), "{log:#?}");
    assert!(log.iter().any(|l| l.starts_with(&format!("GET /v2/ubuntu/manifests/{} ", image.manifest))), "{log:#?}");
    assert_eq!(log.iter().filter(|l| l.contains("/blobs/") && l.ends_with("-> 302")).count(), 3, "{log:#?}");
    assert_eq!(
        log.iter().filter(|l| l.starts_with("GET /cdn/") && l.ends_with("-> 200")).count(),
        3,
        "the token stays off the CDN: {log:#?}"
    );
}

#[test]
fn refuses_a_corrupted_blob_by_name_and_keeps_nothing_of_it() {
    let w = world();
    w.server.corrupt(&w.os_release);
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();

    let err = store.pull(IMAGE, &source(&w.server, "ubuntu", "24.04"), &mut Client::new()).unwrap_err();
    match &err {
        store::Error::Corrupt { digest, actual } => {
            assert_eq!(digest, &w.os_release);
            assert_ne!(actual, &w.os_release);
        }
        other => panic!("expected the corrupt refusal, got {other}"),
    }
    assert!(err.to_string().starts_with(&format!("blob {} is corrupt: its bytes hash to sha256:", w.os_release)), "{err}");
    assert!(!store.has_blob(&w.os_release));
    assert_eq!(store.unpacked(&w.os_release), None);
    assert_eq!(store.image(IMAGE).unwrap(), None);
    let swept = store.sweep().unwrap();
    assert!(swept.partials.is_empty(), "no partial of the corrupt blob stays: {swept:?}");
    let mut expected = vec![w.base.clone(), w.layout.config_digest("ubuntu", "24.04")];
    expected.sort();
    assert_eq!(swept.blobs, expected, "what landed before the corrupt blob is unreferenced and goes");
}

#[test]
fn a_second_pull_answers_from_the_store_without_a_fetch() {
    let w = world();
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let from = source(&w.server, "ubuntu", "24.04");

    let first = store.pull(IMAGE, &from, &mut Client::new()).unwrap();
    let requests = w.server.log().len();
    let second = store.pull(IMAGE, &from, &mut Client::new()).unwrap();
    assert!(!second.fetched);
    assert_eq!(second.image, first.image);
    assert_eq!(w.server.log().len(), requests, "the second pull asked the registry nothing");

    let reopened = Store::open(root.path()).unwrap();
    assert!(!reopened.pull(IMAGE, &from, &mut Client::new()).unwrap().fetched);
    assert_eq!(w.server.log().len(), requests);
}

#[test]
fn reference_counts_follow_images_and_builds_and_the_sweep_takes_what_nothing_names() {
    let w = world();
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let mut client = Client::new();
    let ubuntu = store.pull(IMAGE, &source(&w.server, "ubuntu", "24.04"), &mut client).unwrap().image;
    let tools = store.pull("tools:1", &source(&w.server, "tools", "1"), &mut client).unwrap().image;
    let recipe = "9f".repeat(32);
    store.record_build(&recipe, Chain { config: ubuntu.chain.config.clone(), layers: vec![w.base.clone(), w.os_release.clone()] }).unwrap();
    assert_eq!(store.build(&recipe).unwrap().unwrap().chain.layers, vec![w.base.clone(), w.os_release.clone()]);

    assert_eq!(store.references(&w.base).unwrap(), 2, "ubuntu and the build");
    assert_eq!(store.references(&w.os_release).unwrap(), 3, "ubuntu, tools and the build");
    assert_eq!(store.references(&w.tools).unwrap(), 1);
    assert_eq!(store.references(&tools.chain.config).unwrap(), 1);
    assert_eq!(store.sweep().unwrap(), store::Swept::default(), "everything is named");

    assert!(store.remove_image("tools:1").unwrap());
    assert!(!store.remove_image("tools:1").unwrap());
    assert_eq!(store.references(&w.tools).unwrap(), 0);
    assert_eq!(store.references(&w.os_release).unwrap(), 2);
    let swept = store.sweep().unwrap();
    let mut gone = vec![w.tools.clone(), tools.chain.config.clone()];
    gone.sort();
    assert_eq!(swept.blobs, gone);
    assert_eq!(swept.unpacked, vec![w.tools.clone()]);
    assert!(swept.bytes > 5_000, "{}", swept.bytes);
    assert!(!store.has_blob(&w.tools));
    assert_eq!(store.unpacked(&w.tools), None);
    assert!(store.has_blob(&w.os_release), "the shared layer stays");
    assert!(store.unpacked(&w.os_release).is_some());

    assert!(store.remove_image(IMAGE).unwrap());
    assert_eq!(store.references(&w.base).unwrap(), 1, "the build still names it");
    assert_eq!(store.sweep().unwrap(), store::Swept::default());
    assert!(store.has_blob(&w.base));

    assert!(store.remove_build(&recipe).unwrap());
    let swept = store.sweep().unwrap();
    let mut gone = vec![w.base.clone(), w.os_release.clone(), ubuntu.chain.config.clone()];
    gone.sort();
    assert_eq!(swept.blobs, gone);
    assert_eq!(swept.unpacked, vec![w.base.clone(), w.os_release.clone()].sorted());
    assert_eq!(store.images().unwrap(), vec![]);
}

trait Sorted {
    fn sorted(self) -> Self;
}

impl Sorted for Vec<Digest> {
    fn sorted(mut self) -> Self {
        self.sort();
        self
    }
}

#[test]
fn a_blob_cut_short_is_resumed_from_the_bytes_already_on_disk() {
    let w = world();
    w.server.cut_after(&w.base, 1000);
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let from = source(&w.server, "ubuntu", "24.04");

    let pulled = store.pull(IMAGE, &from, &mut Client::new()).unwrap();
    assert!(pulled.fetched);
    assert!(store.has_blob(&w.base));
    let log = w.server.log();
    let base_blob: Vec<&String> = log.iter().filter(|l| l.starts_with(&format!("GET /cdn/{} ", w.base))).collect();
    assert_eq!(base_blob.len(), 2, "{log:#?}");
    assert_eq!(base_blob[0], &format!("GET /cdn/{} -> 200", w.base), "{log:#?}");
    assert_eq!(base_blob[1], &format!("GET /cdn/{} range=bytes=1000- -> 206", w.base), "{log:#?}");
    assert_eq!(std::fs::read(store.unpacked(&w.base).unwrap().join("bin/sh")).unwrap(), noise(20_000, 7));
}

#[test]
fn a_body_that_moved_no_byte_fails_by_name_and_the_next_pull_starts_it() {
    let w = world();
    w.server.cut_after(&w.base, 0);
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let from = source(&w.server, "ubuntu", "24.04");

    let err = store.pull(IMAGE, &from, &mut Client::new()).unwrap_err();
    assert!(matches!(&err, store::Error::Fetch(fetch::Error::Transport { .. })), "{err}");
    assert!(err.to_string().contains(&format!("/blobs/{}", w.base)), "{err}");
    assert!(!store.has_blob(&w.base));
    assert_eq!(w.server.log().iter().filter(|l| l.starts_with(&format!("GET /cdn/{} ", w.base))).count(), 1);

    assert!(store.pull(IMAGE, &from, &mut Client::new()).unwrap().fetched);
    assert!(store.has_blob(&w.base));
}

#[test]
fn a_partial_that_already_holds_the_blob_costs_no_request_and_one_past_it_starts_over() {
    let w = world();
    let from = source(&w.server, "ubuntu", "24.04");
    let bytes = w.layout.blob_bytes(&w.base);

    let mut whole = tempfile::tempfile().unwrap();
    std::io::Write::write_all(&mut whole, &bytes).unwrap();
    assert_eq!(Client::new().blob(&from, &w.base, &mut whole).unwrap(), bytes.len() as u64);
    assert_eq!(w.server.log(), Vec::<String>::new(), "a complete partial is the blob");

    let mut past = tempfile::tempfile().unwrap();
    std::io::Write::write_all(&mut past, &bytes).unwrap();
    std::io::Write::write_all(&mut past, b"x").unwrap();
    assert_eq!(Client::new().blob(&from, &w.base, &mut past).unwrap(), bytes.len() as u64);
    let mut again = Vec::new();
    std::io::Seek::seek(&mut past, std::io::SeekFrom::Start(0)).unwrap();
    std::io::Read::read_to_end(&mut past, &mut again).unwrap();
    assert_eq!(again, bytes, "the file holds the blob and nothing after it");
    let log = w.server.log();
    let cdn: Vec<&String> = log.iter().filter(|l| l.starts_with("GET /cdn/")).collect();
    assert_eq!(cdn.len(), 2, "{log:#?}");
    assert_eq!(cdn[0], &format!("GET /cdn/{} range=bytes={}- -> 416", w.base, bytes.len() + 1), "{log:#?}");
    assert_eq!(cdn[1], &format!("GET /cdn/{} -> 200", w.base), "{log:#?}");
}

#[test]
fn a_token_endpoint_that_answers_a_challenge_is_refused_by_name_not_asked_again() {
    let w = world();
    w.server.token_refuses();
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();

    let err = store.pull(IMAGE, &source(&w.server, "ubuntu", "24.04"), &mut Client::new()).unwrap_err();
    match &err {
        store::Error::Fetch(fetch::Error::Status { url, status }) => {
            assert_eq!(*status, 401);
            assert!(url.contains("/token?"), "{url}");
        }
        other => panic!("expected the token endpoint's status, got {other}"),
    }
    let log = w.server.log();
    assert_eq!(log.len(), 2, "one challenge, one token request, no loop: {log:#?}");
    assert!(log[1].starts_with("GET /token?") && log[1].ends_with("-> 401"), "{log:#?}");
}

#[test]
fn a_body_that_stalls_is_resumed_where_it_moved_or_given_up_by_name() {
    let w = world();
    w.server.stall(&w.base, 500, Duration::from_millis(900));
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let from = source(&w.server, "ubuntu", "24.04");

    let mut client = Client::with_body_timeout(Duration::from_millis(300));
    let pulled = store.pull(IMAGE, &from, &mut client).unwrap();
    assert!(pulled.fetched);
    let log = w.server.log();
    let base_blob: Vec<&String> = log.iter().filter(|l| l.starts_with(&format!("GET /cdn/{} ", w.base))).collect();
    assert_eq!(base_blob.len(), 2, "{log:#?}");
    assert_eq!(base_blob[1], &format!("GET /cdn/{} range=bytes=500- -> 206", w.base), "{log:#?}");

    let w = world();
    w.server.stall(&w.os_release, 0, Duration::from_millis(2_000));
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path()).unwrap();
    let started = Instant::now();
    let err = store.pull(IMAGE, &source(&w.server, "ubuntu", "24.04"), &mut client).unwrap_err();
    assert!(started.elapsed() < Duration::from_millis(1_500), "gave up inside the budget, not the stall: {:?}", started.elapsed());
    match &err {
        store::Error::Fetch(fetch::Error::Transport { url, detail }) => {
            assert!(url.ends_with(&format!("/blobs/{}", w.os_release)), "{url}");
            assert!(detail.to_ascii_lowercase().contains("timeout") || detail.to_ascii_lowercase().contains("timed out"), "{detail}");
        }
        other => panic!("expected a transport error by name, got {other}"),
    }
    assert!(!store.has_blob(&w.os_release));
}

#[test]
fn whiteouts_in_a_layer_become_what_overlayfs_reads_when_root_unpacks_it() {
    if std::fs::metadata("/proc/self").map(|m| m.uid()).unwrap_or(1) != 0 {
        eprintln!("skipped: whiteouts are made by root");
        return;
    }
    let mut layout = Layout::new();
    let base = layout.layer(&[
        ("usr/", b"", 0o755, 0),
        ("usr/bin/", b"", 0o755, 0),
        ("usr/bin/passwd", b"x", 0o755, 0),
        ("home/", b"", 0o755, 0),
        ("home/agent/", b"", 0o755, 0),
        ("home/agent/old", b"o", 0o644, 0),
    ]);
    let top = layout.layer(&[
        ("usr/", b"", 0o755, 0),
        ("usr/bin/", b"", 0o755, 0),
        ("usr/bin/.wh.passwd", b"", 0o644, 0),
        ("home/", b"", 0o755, 0),
        ("home/agent/", b"", 0o755, 0),
        ("home/agent/.wh..wh..opq", b"", 0o644, 0),
        ("home/agent/new", b"n", 0o644, 0),
    ]);
    layout.image("deletes", "1", &[base, top.clone()]);
    let server = Server::start(layout.dir().to_path_buf());
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    store.pull("deletes:1", &source(&server, "deletes", "1"), &mut Client::new()).unwrap();
    let unpacked = store.unpacked(&top).unwrap();
    let passwd = std::fs::symlink_metadata(unpacked.join("usr/bin/passwd")).unwrap();
    assert!(passwd.file_type().is_char_device(), "the whiteout is a character device");
    assert_eq!(passwd.rdev(), 0, "device 0:0");
    assert!(!unpacked.join("usr/bin/.wh.passwd").exists());
    assert!(!unpacked.join("home/agent/.wh..wh..opq").exists());
    assert_eq!(xattr::get(unpacked.join("home/agent"), "trusted.overlay.opaque").unwrap().as_deref(), Some(&b"y"[..]));
    assert_eq!(std::fs::read(unpacked.join("home/agent/new")).unwrap(), b"n");
}
