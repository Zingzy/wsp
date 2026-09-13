// SPDX-License-Identifier: AGPL-3.0-only
//! One form per layer on a box: a committed layer keeps its unpacked tree and loses its blob, its size reads the
//! tree, and the sweep takes a blob found beside its tree whatever names the layer, and the tree once nothing does.

use std::fs;
use std::path::Path;

use wsp_runtime::fetch::Digest;
use wsp_runtime::store::{Chain, Committed, Store, Swept};

const FILE_BYTES: u64 = 100_000;

/// The file at `file` committed through the store as a one file layer, as a snapshot commits its upper.
fn commit(store: &Store, file: &Path) -> Committed {
    store
        .commit_blob(|out| {
            let mut tar = tar::Builder::new(out);
            tar.append_path_with_name(file, "opt/file")?;
            tar.finish()
        })
        .unwrap()
}

fn base() -> Chain {
    Chain { config: Digest::of(b"config"), layers: vec![Digest::of(b"base")] }
}

#[test]
fn a_layer_committed_once_occupies_one_form_and_its_size_reads_that_form() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let file = dir.path().join("file");
    fs::write(&file, vec![7u8; FILE_BYTES as usize]).unwrap();
    let committed = commit(&store, &file);
    assert!(committed.bytes > FILE_BYTES, "the tar is the file and its headers: {}", committed.bytes);
    let snapshot = store.record_snapshot("v1", "wsp-x", "ubuntu:24.04", &base(), &committed).unwrap();
    let tree = store.unpacked(&committed.digest).expect("the tree is the layer");
    assert_eq!(fs::read(tree.join("opt/file")).unwrap().len() as u64, FILE_BYTES);
    assert!(!store.has_blob(&committed.digest), "the blob went with the unpack");
    assert_eq!(snapshot.layer_bytes, FILE_BYTES, "the size is the tree's, not the tar's {}", committed.bytes);
    assert_eq!(store.sweep(&[]).unwrap(), Swept::default(), "one form, named: nothing to sweep");
}

#[test]
fn a_blob_beside_its_tree_goes_at_the_sweep_and_the_tree_goes_once_nothing_holds_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let file = dir.path().join("file");
    fs::write(&file, vec![7u8; FILE_BYTES as usize]).unwrap();
    let committed = commit(&store, &file);
    let snapshot = store.record_snapshot("v1", "wsp-x", "ubuntu:24.04", &base(), &committed).unwrap();
    // The same layer committed again lands its blob beside the tree: the state a daemon that kept both left behind.
    let again = commit(&store, &file);
    assert_eq!(again.digest, committed.digest);
    assert!(store.has_blob(&committed.digest) && store.unpacked(&committed.digest).is_some(), "two forms");
    let swept = store.sweep(std::slice::from_ref(&snapshot.chain)).unwrap();
    assert_eq!(swept.blobs, vec![committed.digest.clone()], "the blob goes though the snapshot and a workspace hold the layer");
    assert!(swept.unpacked.is_empty(), "{swept:?}");
    assert_eq!(swept.bytes, committed.bytes);
    assert!(store.unpacked(&committed.digest).is_some(), "the tree stays");
    assert!(store.remove_snapshot(&snapshot.id).unwrap());
    let swept = store.sweep(&[]).unwrap();
    assert_eq!(swept.unpacked, vec![committed.digest.clone()]);
    assert_eq!(swept.bytes, FILE_BYTES, "the space freed is the tree's bytes");
    assert!(store.unpacked(&committed.digest).is_none() && !store.has_blob(&committed.digest));
}
