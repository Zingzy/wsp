// SPDX-License-Identifier: AGPL-3.0-only
//! The two reads a slate makes of the thread's own computer: an image by its whole path, and the hashes of the files
//! a command names. Typed and refused as every other frame the daemon serves.

use serde_json::Value;
use wsp_frames::{DaemonErrorCode, DaemonOp, RequestId};

use crate::ops::{answer, not_built, refuse};
use crate::Ctx;

pub(crate) async fn serve(ctx: &Ctx, id: Option<RequestId>, name: &str, frame: &Value) -> String {
    match serde_json::from_value::<DaemonOp>(frame.clone()) {
        Ok(DaemonOp::FsImage { path, machine_id }) => answer(id, crate::image::image_of(ctx, machine_id.as_deref(), path).await),
        Ok(DaemonOp::FsHash { root, paths, machine_id }) => answer(id, crate::hash::hash_of(ctx, machine_id.as_deref(), root, paths).await),
        Ok(_) => refuse(id, DaemonErrorCode::Unsupported, not_built(name)),
        Err(e) => refuse(id, DaemonErrorCode::BadRequest, e.to_string()),
    }
}
