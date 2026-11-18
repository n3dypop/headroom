use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::FetchError;
use crate::providers::claude::{background_command, resolve_bin};

const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const EXIT_GRACE: Duration = Duration::from_secs(1);
const MAX_LINE_BYTES: u64 = 1024 * 1024;

type Replies = Receiver<Result<Vec<u8>, FetchError>>;

pub(super) struct AppServer {
    child: Child,
    input: Option<ChildStdin>,
    replies: Option<Replies>,
    deadline: Instant,
}

impl AppServer {
    pub(super) fn start(bin: &Path, cwd: &Path) -> Result<Self, FetchError> {
        let bin = bin.to_str().ok_or(FetchError::Start)?;
        // On Unix, `nice` can start even if the CLI cannot be found.
        let resolved = resolve_bin(bin).ok_or(FetchError::MissingCli)?;
        let absolute = std::path::absolute(resolved).map_err(|_| FetchError::Start)?;
        let bin = absolute.to_str().ok_or(FetchError::Start)?;
        std::fs::create_dir_all(cwd).map_err(|_| FetchError::StateIo)?;
        let mut child = background_command(bin)
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| match error.kind() {
                io::ErrorKind::NotFound => FetchError::MissingCli,
                _ => FetchError::Start,
            })?;
        let mut server = Self {
            input: child.stdin.take(),
            child,
            replies: None,
            deadline: Instant::now() + RPC_TIMEOUT,
        };
        let stdout = server.child.stdout.take().ok_or(FetchError::Start)?;
        let (tx, rx) = mpsc::sync_channel(4);
        thread::Builder::new()
            .spawn(move || {
                let mut stdout = BufReader::new(stdout);
                loop {
                    let mut line = Vec::new();
                    let result = stdout
                        .by_ref()
                        .take(MAX_LINE_BYTES + 1)
                        .read_until(b'\n', &mut line);
                    let item = match result {
                        Ok(0) => break,
                        Ok(n) if n as u64 <= MAX_LINE_BYTES => Ok(line),
                        Ok(_) => Err(FetchError::Protocol),
                        Err(_) => Err(FetchError::Disconnected),
                    };
                    let failed = item.is_err();
                    if tx.send(item).is_err() || failed {
                        break;
                    }
                }
            })
            .map_err(|_| FetchError::Start)?;
        server.replies = Some(rx);
        Ok(server)
    }

    fn send(&mut self, message: Value) -> Result<(), FetchError> {
        if Instant::now() >= self.deadline {
            return Err(FetchError::Timeout);
        }
        let input = self.input.as_mut().ok_or(FetchError::Disconnected)?;
        serde_json::to_writer(&mut *input, &message).map_err(|_| FetchError::Disconnected)?;
        input
            .write_all(b"\n")
            .and_then(|_| input.flush())
            .map_err(|_| FetchError::Disconnected)
    }

    pub(super) fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, FetchError> {
        self.send(json!({"id":id,"method":method,"params":params}))?;
        let replies = self.replies.as_ref().ok_or(FetchError::Disconnected)?;
        read_response(replies, id, self.deadline)
    }

    pub(super) fn notify_initialized(&mut self) -> Result<(), FetchError> {
        self.send(json!({"method":"initialized"}))
    }
}

fn read_response(replies: &Replies, id: u64, deadline: Instant) -> Result<Value, FetchError> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(FetchError::Timeout)?;
        let line = replies.recv_timeout(remaining).map_err(|e| match e {
            RecvTimeoutError::Timeout => FetchError::Timeout,
            RecvTimeoutError::Disconnected => FetchError::Disconnected,
        })??;
        let mut message: Value = serde_json::from_slice(&line).map_err(|_| FetchError::Protocol)?;
        if message.get("method").is_some() || message["id"].as_u64() != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(match error["code"].as_i64() {
                Some(-32601 | -32602) => FetchError::Unsupported,
                Some(_) => FetchError::Remote,
                None => FetchError::Protocol,
            });
        }
        return message
            .get_mut("result")
            .map(Value::take)
            .ok_or(FetchError::Protocol);
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        drop(self.input.take());
        drop(self.replies.take());
        let deadline = Instant::now() + EXIT_GRACE;
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_cli_is_classified_before_launching_a_background_process() {
        let name = format!("headroom-missing-codex-{}-not-a-cli", std::process::id());
        let directory = std::env::temp_dir();
        let missing_path = directory.join(&name);
        for bin in [missing_path.as_path(), Path::new(&name)] {
            assert!(matches!(
                AppServer::start(bin, &directory),
                Err(FetchError::MissingCli)
            ));
        }
    }

    #[test]
    fn matches_responses_without_using_notifications_or_server_requests() {
        let (tx, rx) = mpsc::channel();
        for message in [
            json!({"method":"account/rateLimits/updated","params":{"result":"notification"}}),
            json!({"method":"account/chatgptAuthTokens/refresh","id":3}),
            json!({"id":1,"result":{"old":true}}),
            json!({"id":3,"result":{"correct":true}}),
        ] {
            tx.send(Ok(serde_json::to_vec(&message).unwrap())).unwrap();
        }
        assert_eq!(
            read_response(&rx, 3, Instant::now() + Duration::from_secs(1)),
            Ok(json!({"correct":true}))
        );
    }

    #[test]
    fn rpc_errors_are_classified_without_their_message() {
        let (tx, rx) = mpsc::channel();
        tx.send(Ok(
            br#"{"id":3,"error":{"code":-32601,"message":"raw response"}}"#.to_vec(),
        ))
        .unwrap();
        assert_eq!(
            read_response(&rx, 3, Instant::now() + Duration::from_secs(1)),
            Err(FetchError::Unsupported)
        );
        assert_eq!(
            read_response(&rx, 3, Instant::now() + Duration::from_millis(10)),
            Err(FetchError::Timeout)
        );
        drop(tx);
        assert_eq!(
            read_response(&rx, 3, Instant::now() + Duration::from_secs(1)),
            Err(FetchError::Disconnected)
        );
    }
}
