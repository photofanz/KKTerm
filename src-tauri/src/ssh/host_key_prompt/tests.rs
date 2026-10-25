use super::*;
use crate::ssh::{
    HostKeyTrustStatus, NativeSshAuth, NativeSshConnectionRequest, connect_verified_client,
    host_key_status,
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Server {
    auth: Arc<AtomicUsize>,
    channels: Vec<russh::Channel<russh::server::Msg>>,
}
impl russh::server::Handler for Server {
    type Error = russh::Error;
    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        self.channels.push(channel);
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: russh::ChannelId,
        name: &str,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(name, "sftp");
        session.channel_success(channel)?;
        Ok(())
    }
    async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
        self.auth.fetch_add(1, Ordering::SeqCst);
        Ok(russh::server::Auth::Reject {
            proceed_with_methods: None,
            partial_success: false,
        })
    }
    async fn auth_password(
        &mut self,
        _: &str,
        password: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        assert_eq!(password, "secret");
        self.auth.fetch_add(1, Ordering::SeqCst);
        Ok(russh::server::Auth::Accept)
    }
}

fn prompt(
    budget: Arc<SshStartupBudget>,
) -> (
    HostKeyPrompt,
    tokio::sync::mpsc::UnboundedReceiver<Challenge>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (
        HostKeyPrompt {
            emit: Arc::new(move |c| tx.send(c).map_err(|e| e.to_string())),
            session_id: "test-session".into(),
            budget,
            cancel: CancellationToken::new(),
        },
        rx,
    )
}

struct Fixture {
    request: NativeSshConnectionRequest,
    challenges: tokio::sync::mpsc::UnboundedReceiver<Challenge>,
    accepted: Arc<AtomicUsize>,
    auth: Arc<AtomicUsize>,
    key: russh::keys::ssh_key::PublicKey,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.request.known_hosts_path);
    }
}
impl Fixture {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let private = russh::keys::ssh_key::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let key = private.public_key().clone();
        let config = Arc::new(russh::server::Config {
            keys: vec![private],
            ..Default::default()
        });
        let accepted = Arc::new(AtomicUsize::new(0));
        let auth = Arc::new(AtomicUsize::new(0));
        let server_accepted = accepted.clone();
        let server_auth = auth.clone();
        let task = tokio::spawn(async move {
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                server_accepted.fetch_add(1, Ordering::SeqCst);
                let config = config.clone();
                let handler = Server {
                    auth: server_auth.clone(),
                    channels: Vec::new(),
                };
                sessions.spawn(async move {
                    if let Ok(session) = russh::server::run_stream(config, stream, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        let (prompt, challenges) = prompt(Arc::new(SshStartupBudget::new(Duration::from_secs(5))));
        let path = std::env::temp_dir().join(format!("kkterm-806-{}-{port}", std::process::id()));
        let request = NativeSshConnectionRequest {
            host: "127.0.0.1".into(),
            port,
            user: "test".into(),
            auth: NativeSshAuth::Password {
                password: Some("secret".into()),
            },
            known_hosts_path: path,
            host_key_prompt: Some(prompt),
            x11_forwarding: None,
            socks_proxy: None,
            compression: false,
            old_protocols: false,
            remote_forward_targets: None,
            bridge_tasks: None,
        };
        Self {
            request,
            challenges,
            accepted,
            auth,
            key,
            task,
        }
    }
    async fn challenge(&mut self) -> Challenge {
        tokio::time::timeout(Duration::from_secs(3), self.challenges.recv())
            .await
            .unwrap()
            .unwrap()
    }
    fn pin(&self, key: &russh::keys::ssh_key::PublicKey) {
        russh::keys::known_hosts::learn_known_hosts_path(
            "127.0.0.1",
            self.request.port,
            key,
            &self.request.known_hosts_path,
        )
        .unwrap();
    }
}

#[tokio::test]
async fn unknown_confirmation_authenticates_on_one_transport_and_reconnect_checks_pin() {
    let mut f = Fixture::new().await;
    let connect = tokio::spawn(connect_verified_client(f.request.clone()));
    let challenge = f.challenge().await;
    assert_eq!(challenge.preview.status, "unknown");
    assert_eq!(f.accepted.load(Ordering::SeqCst), 1);
    assert_eq!(f.auth.load(Ordering::SeqCst), 0, "no auth before trust");
    respond_host_key(challenge.request_id.clone(), true, false).unwrap();
    let session = connect.await.unwrap().unwrap();
    assert_eq!(f.accepted.load(Ordering::SeqCst), 1, "no throwaway probe");
    assert!(f.auth.load(Ordering::SeqCst) > 0);
    // SFTP opens its subsystem only after this same verified transport authenticates.
    let mut channel = session.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), channel.wait())
            .await
            .unwrap(),
        Some(russh::ChannelMsg::Success)
    ));
    channel.close().await.unwrap();
    assert!(respond_host_key(challenge.request_id, true, true).is_err());
    session
        .disconnect(russh::Disconnect::ByApplication, "done", "en")
        .await
        .unwrap();
    let reconnect = connect_verified_client(f.request.clone()).await.unwrap();
    assert_eq!(f.accepted.load(Ordering::SeqCst), 2);
    assert!(
        f.challenges.try_recv().is_err(),
        "trusted reconnect needs no confirmation"
    );
    reconnect
        .disconnect(russh::Disconnect::ByApplication, "done", "en")
        .await
        .unwrap();
}

#[tokio::test]
async fn changed_key_requires_explicit_replacement_and_rejection_sends_no_credentials() {
    for (accept, replace) in [(false, false), (true, false), (true, true)] {
        let mut f = Fixture::new().await;
        let old = russh::keys::ssh_key::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        f.pin(old.public_key());
        let connect = tokio::spawn(connect_verified_client(f.request.clone()));
        let challenge = f.challenge().await;
        assert_eq!(challenge.preview.status, "changed");
        assert_eq!(f.auth.load(Ordering::SeqCst), 0);
        respond_host_key(challenge.request_id, accept, replace).unwrap();
        let result = connect.await.unwrap();
        if accept && replace {
            let session = result.unwrap();
            assert!(f.auth.load(Ordering::SeqCst) > 0);
            assert_eq!(
                host_key_status(
                    "127.0.0.1",
                    f.request.port,
                    &f.key,
                    &f.request.known_hosts_path
                )
                .unwrap(),
                HostKeyTrustStatus::Trusted
            );
            session
                .disconnect(russh::Disconnect::ByApplication, "done", "en")
                .await
                .unwrap();
        } else {
            assert!(result.is_err());
            assert_eq!(f.auth.load(Ordering::SeqCst), 0);
            assert_eq!(
                host_key_status(
                    "127.0.0.1",
                    f.request.port,
                    old.public_key(),
                    &f.request.known_hosts_path
                )
                .unwrap(),
                HostKeyTrustStatus::Trusted
            );
        }
        assert_eq!(f.accepted.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn cancellation_and_dropped_startup_revoke_pending_challenges() {
    for abort in [false, true] {
        let mut f = Fixture::new().await;
        let connect = tokio::spawn(connect_verified_client(f.request.clone()));
        let challenge = f.challenge().await;
        if abort {
            connect.abort();
        } else {
            f.request.host_key_prompt.as_ref().unwrap().cancel.cancel();
        }
        let _ = connect.await;
        tokio::task::yield_now().await;
        assert!(respond_host_key(challenge.request_id, true, true).is_err());
        assert_eq!(f.auth.load(Ordering::SeqCst), 0);
        assert!(!f.request.known_hosts_path.exists());
    }
}

#[tokio::test]
async fn noninteractive_callers_fail_closed_for_unknown_hosts() {
    let mut f = Fixture::new().await;
    f.request.host_key_prompt = None;
    assert!(connect_verified_client(f.request.clone()).await.is_err());
    assert_eq!(f.auth.load(Ordering::SeqCst), 0);
    assert!(f.challenges.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn unanswered_prompt_times_out_without_accepting_a_late_reply() {
    let budget = Arc::new(SshStartupBudget::new(Duration::from_secs(15)));
    let (prompt, mut challenges) = prompt(budget.clone());
    let confirm = tokio::spawn(async move {
        prompt
            .confirm(SshHostKeyPreview {
                host: "test".into(),
                port: 22,
                algorithm: "ssh-ed25519".into(),
                fingerprint: "test".into(),
                public_key: "test".into(),
                status: "unknown".into(),
            })
            .await
    });
    let challenge = challenges.recv().await.unwrap();
    tokio::time::advance(CONFIRM_TIMEOUT).await;
    assert!(confirm.await.unwrap().unwrap_err().contains("timed out"));
    assert!(respond_host_key(challenge.request_id, true, false).is_err());
    assert!(
        budget.clock.lock().unwrap().1.is_some(),
        "resume machine budget after prompt"
    );
}

#[tokio::test(start_paused = true)]
async fn confirmation_pauses_and_resumes_both_outer_and_handshake_deadlines() {
    let budget = SshStartupBudget::new(Duration::from_secs(15));
    let start = tokio::time::Instant::now();
    tokio::join!(
        budget.expired(),
        budget.expired(),
        budget.wait_for_input(tokio::time::sleep(Duration::from_secs(30))),
    );
    assert_eq!(start.elapsed(), Duration::from_secs(45));
}

#[tokio::test]
async fn unknown_key_rejection_and_stalled_handshake_never_send_authentication() {
    let mut f = Fixture::new().await;
    let connect = tokio::spawn(connect_verified_client(f.request.clone()));
    let challenge = f.challenge().await;
    respond_host_key(challenge.request_id, false, false).unwrap();
    assert!(connect.await.unwrap().is_err());
    assert_eq!(f.auth.load(Ordering::SeqCst), 0);
    assert!(!f.request.known_hosts_path.exists());

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    f.request.port = listener.local_addr().unwrap().port();
    f.request.host_key_prompt.as_mut().unwrap().budget =
        Arc::new(SshStartupBudget::new(Duration::from_millis(30)));
    let connect = tokio::spawn(connect_verified_client(f.request.clone()));
    let (_socket, _) = listener.accept().await.unwrap();
    // A peer that accepts TCP but sends no SSH banner still has a machine deadline.
    let result = tokio::time::timeout(Duration::from_secs(2), connect)
        .await
        .unwrap()
        .unwrap();
    assert!(result.err().unwrap().contains("timed out"));
    assert!(f.challenges.try_recv().is_err());
    assert!(!f.request.known_hosts_path.exists());
}
