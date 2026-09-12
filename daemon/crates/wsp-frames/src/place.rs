// SPDX-License-Identifier: AGPL-3.0-only
//! The handshake a place opens toward its host, and the report it carries. The encodings both sides sign and
//! send are pinned here as the protocol pins them: a nonce, a key and a signature are base64 of a fixed byte count.

use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::num::NonZeroU16;

use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use base64::{alphabet, Engine};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

use crate::validate::{bounded, bounded_list, http_url, non_empty_list};
use crate::RequestId;

/// Decodes what the protocol's regex accepts: the standard alphabet, padded, with the trailing bits of the last
/// symbol left unchecked, since the zod side counts bytes off the text and never decodes.
const AS_ZOD: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true));

/// Base64 text that decodes to exactly N bytes; anything else is refused at the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Base64Bytes<const N: usize> {
    text: String,
    #[serde(skip)]
    _n: PhantomData<[u8; N]>,
}

impl<const N: usize> Base64Bytes<N> {
    pub fn from_bytes(bytes: &[u8; N]) -> Self {
        Base64Bytes { text: STANDARD.encode(bytes), _n: PhantomData }
    }

    pub fn parse(text: &str) -> Option<Self> {
        if !text.len().is_multiple_of(4) || !text.trim_end_matches('=').bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        {
            return None;
        }
        let decoded = AS_ZOD.decode(text).ok()?;
        (decoded.len() == N).then(|| Base64Bytes { text: text.to_owned(), _n: PhantomData })
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn to_bytes(&self) -> [u8; N] {
        let mut out = [0u8; N];
        out.copy_from_slice(&AS_ZOD.decode(&self.text).expect("validated at construction"));
        out
    }
}

impl<'de, const N: usize> Deserialize<'de> for Base64Bytes<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Base64Bytes::parse(&text).ok_or_else(|| de::Error::custom(format!("must be {N} bytes, base64")))
    }
}

pub type PlaceNonce = Base64Bytes<{ crate::numbers::PLACE_LINK_NONCE_BYTES }>;
/// An ed25519 public key as SPKI DER.
pub type PlacePublicKey = Base64Bytes<44>;
/// An ed25519 signature.
pub type PlaceSignature = Base64Bytes<64>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSize {
    pub cpu: f64,
    pub mem_mb: u64,
}

/// What a place says about itself on every link. agents names the catalog ids found on its login PATH.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceReport {
    #[serde(deserialize_with = "bounded::<_, 1, 200>")]
    pub name: String,
    pub platform: Platform,
    #[serde(deserialize_with = "bounded::<_, 0, 32>")]
    pub arch: String,
    #[serde(deserialize_with = "bounded::<_, 0, 200>")]
    pub os: String,
    pub shape: WorkspaceSize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_free_bytes: Option<u64>,
    pub login: BTreeMap<String, String>,
    pub docker: bool,
    pub daemon_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_port: Option<NonZeroU16>,
    #[serde(deserialize_with = "non_empty_list")]
    pub wsp: Vec<String>,
    #[serde(deserialize_with = "http_url")]
    pub dialed: String,
    #[serde(deserialize_with = "bounded_list::<_, 32, 32>")]
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum PlaceAuthTag {
    #[serde(rename = "place.auth")]
    PlaceAuth,
}

/// The first frame of a place that already joined: names itself and challenges the host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceAuthRequest {
    pub id: RequestId,
    op: PlaceAuthTag,
    #[serde(deserialize_with = "bounded::<_, 0, 64>")]
    pub place_id: String,
    pub nonce: PlaceNonce,
}

impl PlaceAuthRequest {
    pub fn new(id: RequestId, place_id: impl Into<String>, nonce: PlaceNonce) -> Self {
        PlaceAuthRequest { id, op: PlaceAuthTag::PlaceAuth, place_id: place_id.into(), nonce }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceAuthReply {
    pub nonce: PlaceNonce,
    pub host_public_key: PlacePublicKey,
    pub signature: PlaceSignature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum PlaceProveTag {
    #[serde(rename = "place.prove")]
    PlaceProve,
}

/// The second frame: the place's answer to the host's nonce, and its report as it stands now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlaceProveRequest {
    pub id: RequestId,
    op: PlaceProveTag,
    pub signature: PlaceSignature,
    pub report: PlaceReport,
}

impl PlaceProveRequest {
    pub fn new(id: RequestId, signature: PlaceSignature, report: PlaceReport) -> Self {
        PlaceProveRequest { id, op: PlaceProveTag::PlaceProve, signature, report }
    }
}
