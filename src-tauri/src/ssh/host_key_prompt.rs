use super::{SshHostKeyPreview, SshStartupBudget};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::Emitter;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(super) const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
type Replies = Mutex<HashMap<String, oneshot::Sender<Option<bool>>>>;
fn replies() -> &'static Replies {
    static REPLIES: OnceLock<Replies> = OnceLock::new();
    REPLIES.get_or_init(Mutex::default)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Challenge {
    request_id: String,
    session_id: String,
    preview: SshHostKeyPreview,
}

// The guard also removes challenges when the handshake future is dropped. A late
// response can never trust a key or authorize a different connection attempt.
struct Pending(String);
impl Drop for Pending {
    fn drop(&mut self) {
        replies().lock().unwrap().remove(&self.0);
    }
}

pub(crate) fn respond_host_key(
    request_id: String,
    accept: bool,
    replace: bool,
) -> Result<(), String> {
    let reply = replies()
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or_else(|| "SSH host-key request has expired".to_string())?;
    reply
        .send(accept.then_some(replace))
        .map_err(|_| "SSH host-key request has expired".to_string())
}

#[derive(Clone)]
pub(crate) struct HostKeyPrompt {
    emit: Arc<dyn Fn(Challenge) -> Result<(), String> + Send + Sync>,
    session_id: String,
    pub(super) budget: Arc<SshStartupBudget>,
    pub(super) cancel: CancellationToken,
}

impl HostKeyPrompt {
    pub(crate) fn new(
        app: tauri::AppHandle,
        session_id: String,
        budget: Arc<SshStartupBudget>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            emit: Arc::new(move |challenge| {
                app.emit("ssh-host-key-request", challenge)
                    .map_err(|e| e.to_string())
            }),
            session_id,
            budget,
            cancel,
        }
    }

    pub(super) async fn confirm(&self, preview: SshHostKeyPreview) -> Result<bool, String> {
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let request_id = NEXT_ID
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .to_string();
        let (tx, rx) = oneshot::channel();
        replies().lock().unwrap().insert(request_id.clone(), tx);
        let _pending = Pending(request_id.clone());
        let changed = preview.status == "changed";
        (self.emit)(Challenge {
            request_id,
            session_id: self.session_id.clone(),
            preview,
        })?;
        self.budget.wait_for_input(async {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => Err("SSH host-key confirmation canceled".to_string()),
                result = tokio::time::timeout(CONFIRM_TIMEOUT, rx) => match result {
                    Ok(Ok(Some(replace))) if !changed || replace => Ok(changed && replace),
                    Ok(_) => Err("SSH host key was not trusted".to_string()),
                    Err(_) => Err("timed out waiting for SSH host-key confirmation".to_string()),
                }
            }
        }).await
    }
}

#[cfg(test)]
mod tests;
