// SPDX-License-Identifier: AGPL-3.0-only
//! A new daemon binary from the host, landed in place of the running one.

use std::sync::Arc;

use serde_json::Value;
use wsp_frames::{words, DaemonErrorCode, DaemonOp, PlaceUpdateReply, Reply, RequestId};

use super::{fail, lenient_base64, ok, refuse};
use crate::paths::OpError;
use crate::{frame_text as text, fs, Ctx, Outgoing};

/// The daemon the host sent, landed part by part and started in place of this one. Every part but the last is a
/// plain reply; the last checks the bytes against the sha256 the host named, moves them over the binary this
/// process runs from and answers where they went, and the loop then ends this daemon so its supervisor starts the
/// one that landed. Nothing here sweeps: the workspaces' records stay on the box and the daemon that comes up
/// reads them again.
pub(super) async fn place_update(ctx: &Arc<Ctx>, id: Option<RequestId>, frame: &Value) -> Outgoing {
    let typed = match serde_json::from_value::<DaemonOp>(frame.clone()) {
        Ok(typed) => typed,
        Err(e) => return Outgoing::Text(refuse(id, DaemonErrorCode::BadRequest, e.to_string())),
    };
    let DaemonOp::PlaceUpdate { upload_id, seq, last, data, sha256 } = typed else {
        return Outgoing::Text(fail(id, words::unknown_op("place.update")));
    };
    let home = crate::place::place_home(ctx.options.home.as_deref());
    let bytes = lenient_base64(&data);
    let part = crate::place::update_part(&home, &upload_id);
    // An upload beginning is the other moment nothing is arriving, so what an earlier try left goes here too.
    if seq == 0 {
        let (home, upload) = (home.clone(), upload_id.clone());
        let _ = fs::blocking(move || Ok(crate::place::sweep_updates(&home, Some(&upload)))).await;
    }
    let taking = {
        let (part, upload) = (part.clone(), upload_id.clone());
        fs::blocking(move || crate::place::take_update_part(&part, seq, &bytes, &upload).map_err(OpError::plain)).await
    };
    if let Err(e) = taking {
        return Outgoing::Text(fail(id, e.message));
    }
    if !last {
        return Outgoing::Text(ok(id));
    }
    // Its own path rather than the unit's: the binary a unit starts is the file this process was execed from, and
    // reading it here needs neither the unit's name nor the manager that holds it.
    let exe = match crate::place::running_daemon(std::env::current_exe()) {
        Ok(exe) => exe,
        Err(e) => return Outgoing::Text(fail(id, e)),
    };
    let landed = fs::blocking(move || crate::place::install_daemon(&exe, &part, &sha256, &upload_id).map_err(OpError::plain)).await;
    match landed {
        Err(e) => Outgoing::Text(fail(id, e.message)),
        Ok((at, kept)) => {
            ctx.log(&words::update_landed(&at));
            Outgoing::Restart(text(&Reply::new(id, PlaceUpdateReply { at, kept })))
        }
    }
}
