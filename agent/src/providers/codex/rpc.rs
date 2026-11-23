use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{FetchError, Outcome, Query, Run};
use crate::providers::claude::{background_command, resolve_bin};

const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const EXIT_GRACE: Duration = Duration::from_secs(1);
const MAX_LINE_BYTES: u64 = 1024 * 1024;

type Replies = Receiver<Result<Vec<u8>, FetchError>>;

type Clocks = fn(crate::time::ReadFirst) -> Option<(Duration, Duration)>;

/// Whether the computer slept during one wait for a reply: the clocks are read as the wait begins and the moment it ends in a timeout
/// or a lost connection. A sleep before it (while the server was got ready) or after it (while the server is shut down) never counts
#[derive(Clone, Copy)]
pub(super) struct Asleep(Clocks);

impl Asleep {
    pub(super) fn new(clocks: Clocks) -> Self {
        Self(clocks)
    }

    fn begin(&self) -> Option<(Duration, Duration)> {
        (self.0)(crate::time::ReadFirst::Stopping)
    }

    fn since(&self, begun: Option<(Duration, Duration)>) -> bool {
        crate::time::slept_during(begun, (self.0)(crate::time::ReadFirst::RunningOn))
    }

    /// No sleep is ever told (the clocks can't be read)
    #[cfg(test)]
    pub(super) fn never() -> Self {
        Self(|_| None)
    }
}

pub(super) struct AppServer {
    child: Child,
    input: Option<ChildStdin>,
    replies: Option<Replies>,
    deadline: Instant,
    asleep: Asleep,
}

impl AppServer {
    pub(super) fn start(
        bin: &Path,
        cwd: &Path,
        before_spawn: impl FnOnce() -> Result<(), FetchError>,
    ) -> Result<Self, FetchError> {
        let asleep = Asleep::new(crate::time::sleep_clocks);
        let bin = bin.to_str().ok_or(FetchError::Start)?;
        // On Unix, `nice` can start even if the CLI cannot be found.
        let resolved = resolve_bin(bin).ok_or(FetchError::MissingCli)?;
        let absolute = std::path::absolute(resolved).map_err(|_| FetchError::Start)?;
        let bin = absolute.to_str().ok_or(FetchError::Start)?;
        std::fs::create_dir_all(cwd).map_err(|_| FetchError::StateIo)?;
        let mut command = background_command(bin);
        command
            .args(["app-server", "--listen", "stdio://"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        before_spawn()?;
        let mut child = command.spawn().map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => FetchError::MissingCli,
            _ => FetchError::Start,
        })?;
        let mut server = Self {
            input: child.stdin.take(),
            child,
            replies: None,
            deadline: Instant::now() + RPC_TIMEOUT,
            asleep,
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

    pub(super) fn connection(&mut self) -> Result<Connection<'_>, FetchError> {
        Ok(Connection {
            input: self.input.as_mut().ok_or(FetchError::Disconnected)?,
            replies: self.replies.as_ref().ok_or(FetchError::Disconnected)?,
            deadline: self.deadline,
            asleep: self.asleep,
        })
    }
}

pub(super) struct Connection<'a> {
    pub(super) input: &'a mut dyn Write,
    pub(super) replies: &'a Replies,
    pub(super) deadline: Instant,
    pub(super) asleep: Asleep,
}

impl Connection<'_> {
    /// Writes one message. Returns the clocks read right before its bytes are written (after it is built and its deadline and turn
    /// are checked): a sleep from then until the wait for its reply ends counts as cutting it off
    fn send(
        &mut self,
        message: Value,
        before_write: impl FnOnce() -> Result<(), FetchError>,
    ) -> Result<Option<(Duration, Duration)>, FetchError> {
        let mut frame = serde_json::to_vec(&message).map_err(|_| FetchError::Protocol)?;
        frame.push(b'\n');
        if Instant::now() >= self.deadline {
            return Err(FetchError::Timeout);
        }
        before_write()?;
        let begun = self.asleep.begin();
        self.input
            .write_all(&frame)
            .and_then(|_| self.input.flush())
            .map_err(|_| FetchError::Disconnected)?;
        Ok(begun)
    }

    pub(super) fn request(
        &mut self,
        query: &mut Query<'_>,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, FetchError> {
        let target = matches!(method, "account/read" | "account/rateLimits/read");
        let begun = self.send(json!({"id":id,"method":method,"params":params}), || {
            if target { query.before_write() } else { Ok(()) }
        })?;
        let result = read_response(
            self.replies,
            id,
            method,
            self.deadline,
            || query.now(),
            self.asleep,
            begun,
        );
        if target {
            let confirmed = match &result {
                Err(FetchError::AccessDenied) => Outcome::AccessDenied,
                Err(FetchError::RateLimited { retry_ms }) => Outcome::RateLimited {
                    retry_ms: *retry_ms,
                },
                // A complete reply is known. Success requires both replies and a usable observation. A wait cut off by the
                // computer's sleep is an ordinary failure too, tried again (not a result left unknown, which would stop fetching
                // until the user replaced it)
                Ok(_)
                | Err(
                    FetchError::Remote
                    | FetchError::Unsupported
                    | FetchError::SignedOut
                    | FetchError::Suspended,
                ) => Outcome::Failed,
                _ => return result,
            };
            *query.run = Some(Run::Ran(confirmed));
        }
        result
    }

    pub(super) fn notify_initialized(&mut self) -> Result<(), FetchError> {
        self.send(json!({"method":"initialized"}), || Ok(()))
            .map(|_| ())
    }
}

fn read_response(
    replies: &Replies,
    id: u64,
    method: &str,
    deadline: Instant,
    now: impl Fn() -> i64,
    asleep: Asleep,
    begun: Option<(Duration, Duration)>,
) -> Result<Value, FetchError> {
    // The wait ran out, or the server went away, while waiting: told as cut off by a sleep if the computer slept since the request
    // was written (`begun`), decided then
    let cut = |error| {
        if asleep.since(begun) {
            FetchError::Suspended
        } else {
            error
        }
    };
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(cut(FetchError::Timeout));
        };
        let line = match replies.recv_timeout(remaining) {
            Ok(Ok(line)) => line,
            Ok(Err(FetchError::Disconnected)) | Err(RecvTimeoutError::Disconnected) => {
                return Err(cut(FetchError::Disconnected));
            }
            Ok(Err(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => return Err(cut(FetchError::Timeout)),
        };
        let mut message: Value = serde_json::from_slice(&line).map_err(|_| FetchError::Protocol)?;
        if message.get("method").is_some() || message["id"].as_u64() != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            if message.get("result").is_some() || !error["message"].is_string() {
                return Err(FetchError::Protocol);
            }
            return Err(match error["code"].as_i64() {
                Some(-32601 | -32602) => FetchError::Unsupported,
                Some(code) if matches!(method, "account/read" | "account/rateLimits/read") => {
                    upstream_error(method, code, error, now()).unwrap_or(FetchError::Remote)
                }
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

fn upstream_error(method: &str, code: i64, error: &Value, now: i64) -> Option<FetchError> {
    // Only server errors can carry an upstream diagnostic.
    if !matches!(code, -32603 | -32099..=-32000) {
        return None;
    }
    let data = &error["data"];
    if !data.is_null() {
        let info = &data["codexErrorInfo"];
        if info.as_str() == Some("rateLimitExceeded") {
            return Some(FetchError::RateLimited { retry_ms: None });
        }
        let http = info.get("httpConnectionFailed")?;
        let status = match http.get("httpStatusCode") {
            Some(value) if !value.is_null() => value.as_u64()?,
            _ => match http["reason"].as_str()? {
                "access_denied" => 403,
                "rate_limit_exceeded" => 429,
                _ => return None,
            },
        };
        return match status {
            // The sign-in was refused upstream (expired or revoked): signed out, as for every provider (sign in again)
            401 => Some(FetchError::SignedOut),
            403 => Some(FetchError::AccessDenied),
            429 => Some(FetchError::RateLimited {
                retry_ms: retry_ms(http, now),
            }),
            _ => None,
        };
    }
    // The backend client formats the status before the content type and the untrusted body.
    const PREFIX: &str = "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: ";
    if method != "account/rateLimits/read" || code != -32603 {
        return None;
    }
    let tail = error["message"].as_str()?.strip_prefix(PREFIX)?;
    let (status, rest) = tail.split_once("; content-type=")?;
    rest.split_once("; body=")?;
    match status {
        "401 Unauthorized" => Some(FetchError::SignedOut),
        "403 Forbidden" => Some(FetchError::AccessDenied),
        "429 Too Many Requests" => Some(FetchError::RateLimited { retry_ms: None }),
        _ => None,
    }
}

fn retry_ms(http: &Value, now: i64) -> Option<i64> {
    const IMF_FIXDATE: &str = "%a, %d %b %Y %H:%M:%S GMT";
    let mut headers = http["headers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(name, _)| name.eq_ignore_ascii_case("retry-after"));
    let ms = match (headers.next(), http.get("retryAfterMs")) {
        (Some((_, header)), None) if headers.next().is_none() => {
            let text = header.as_str()?.trim_matches([' ', '\t']);
            if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
                text.parse::<i64>().ok()?.checked_mul(1000)?
            } else {
                let dt = jiff::civil::DateTime::strptime(IMF_FIXDATE, text).ok()?;
                if dt.strftime(IMF_FIXDATE).to_string() != text {
                    return None;
                }
                dt.to_zoned(jiff::tz::TimeZone::UTC)
                    .ok()?
                    .timestamp()
                    .as_millisecond()
                    .checked_sub(now)?
                    .max(0)
            }
        }
        (None, Some(value)) => value.as_i64().filter(|&ms| ms >= 0)?,
        _ => return None,
    };
    // Use whole seconds on both the local schedule and the wire. Reject unrepresentable deadlines.
    let rounded = (ms.checked_add(999)? / 1000) * 1000;
    jiff::Timestamp::from_millisecond(now.checked_add(rounded)?).ok()?;
    Some(rounded)
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

    fn limits_response(rx: &Replies, wait: Duration) -> Result<Value, FetchError> {
        read_response(
            rx,
            3,
            "account/rateLimits/read",
            Instant::now() + wait,
            || 0,
            Asleep::never(),
            None,
        )
    }

    #[test]
    fn an_rpc_error_needs_upstream_provenance() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/codex/synthetic-rpc-errors.json"
        ))
        .unwrap();
        let classify = |method: &str, error: &Value| {
            let (tx, rx) = mpsc::channel();
            let frame = json!({"id":3,"error":error});
            tx.send(Ok(serde_json::to_vec(&frame).unwrap())).unwrap();
            let until = Instant::now() + Duration::from_secs(1);
            read_response(&rx, 3, method, until, || 0, Asleep::never(), None).unwrap_err()
        };
        let method = "account/rateLimits/read";
        let error = &fixture["backend"]["error"];
        let msg = error["message"].as_str().unwrap();
        let denied = &fixture["denied"]["error"];
        assert_eq!(classify("initialize", denied), FetchError::Remote);
        assert_eq!(classify("account/read", error), FetchError::Remote);
        let other_status = msg.replace("429 Too Many Requests", "500 Internal Server Error");
        for (code, message) in [
            (403, "403 Forbidden"),
            (429, "retry later"),
            (-32603, "upstream said 403"),
            (-32603, other_status.as_str()),
        ] {
            let e = json!({"code":code,"message":message});
            assert_eq!(classify(method, &e), FetchError::Remote);
        }
        let text = msg.replace("429 Too Many Requests", "403 Forbidden");
        let e = json!({"code":-32603,"message":text});
        assert_eq!(classify(method, &e), FetchError::AccessDenied);
        // a sign-in refused upstream (synthetic, of the same forms as the 403): signed out; a bare 401 or one in free text isn't
        let text = msg.replace("429 Too Many Requests", "401 Unauthorized");
        let e = json!({"code":-32603,"message":text});
        assert_eq!(classify(method, &e), FetchError::SignedOut);
        let mut e = denied.clone();
        e["data"]["codexErrorInfo"]["httpConnectionFailed"] = json!({"httpStatusCode":401});
        assert_eq!(classify("account/read", &e), FetchError::SignedOut);
        assert_eq!(classify("initialize", &e), FetchError::Remote);
        for (code, message) in [(401, "401 Unauthorized"), (-32603, "upstream said 401")] {
            let e = json!({"code":code,"message":message});
            assert_eq!(classify(method, &e), FetchError::Remote);
        }

        let mut e = denied.clone();
        e["data"]["codexErrorInfo"]["httpConnectionFailed"] = json!({"reason":"access_denied"});
        assert_eq!(classify("account/read", &e), FetchError::AccessDenied);
        e["data"]["codexErrorInfo"] = json!("rateLimitExceeded");
        assert_eq!(
            classify(method, &e),
            FetchError::RateLimited { retry_ms: None }
        );
    }

    #[test]
    fn only_valid_waits_on_a_confirmed_429_are_kept() {
        let now = 1_795_000_000_999;
        let header = |value| json!({"headers":{"Retry-After":value}});
        for (mut http, expected) in [
            (json!({}), None),
            (header("21600"), Some(21_600_000)),
            (header("Wed, 18 Nov 2026 11:06:42 GMT"), Some(2_000)),
            (header("Thu, 18 Nov 2026 11:06:42 GMT"), None),
            (header("1.5"), None),
            (header("-1"), None),
            (header("9999999999999999999"), None),
            (json!({"retryAfterMs":1_001}), Some(2_000)),
        ] {
            http["httpStatusCode"] = json!(429);
            let error = json!({"data":{"codexErrorInfo":{"httpConnectionFailed":http}}});
            assert_eq!(
                upstream_error("account/read", -32603, &error, now),
                Some(FetchError::RateLimited { retry_ms: expected })
            );
        }
    }

    #[test]
    fn missing_cli_is_classified_before_launching_a_background_process() {
        let name = format!("headroom-missing-codex-{}-not-a-cli", std::process::id());
        let directory = std::env::temp_dir();
        let missing_path = directory.join(&name);
        for bin in [missing_path.as_path(), Path::new(&name)] {
            assert!(matches!(
                AppServer::start(bin, &directory, || panic!("missing executable")),
                Err(FetchError::MissingCli)
            ));
        }
    }

    #[test]
    fn an_expired_grant_after_setup_prevents_spawn() {
        let root = crate::test_util::TempHome::new("codex-expired-spawn");
        let cwd = root.join("cwd");
        let bin = std::env::current_exe().unwrap();
        let start = AppServer::start(&bin, &cwd, || {
            assert!(cwd.is_dir());
            Err(FetchError::GrantExpired)
        });
        assert!(matches!(start, Err(FetchError::GrantExpired)));
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
            limits_response(&rx, Duration::from_secs(1)),
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
            limits_response(&rx, Duration::from_secs(1)),
            Err(FetchError::Unsupported)
        );
        assert_eq!(
            limits_response(&rx, Duration::from_millis(10)),
            Err(FetchError::Timeout)
        );
        drop(tx);
        assert_eq!(
            limits_response(&rx, Duration::from_secs(1)),
            Err(FetchError::Disconnected)
        );
    }

    #[test]
    fn a_wait_cut_off_while_the_computer_slept_is_told_so_and_nothing_else_is() {
        fn asleep(first: crate::time::ReadFirst) -> Option<(Duration, Duration)> {
            Some(match first {
                crate::time::ReadFirst::Stopping => (Duration::ZERO, Duration::ZERO),
                crate::time::ReadFirst::RunningOn => {
                    (Duration::from_secs(600), Duration::from_secs(1))
                }
            })
        }
        fn awake(first: crate::time::ReadFirst) -> Option<(Duration, Duration)> {
            Some(match first {
                crate::time::ReadFirst::Stopping => (Duration::ZERO, Duration::ZERO),
                crate::time::ReadFirst::RunningOn => {
                    (Duration::from_secs(1), Duration::from_secs(1))
                }
            })
        }
        let wait = |rx: &Replies, ms: u64, slept: bool| {
            let clocks = Asleep::new(if slept { asleep } else { awake });
            read_response(
                rx,
                3,
                "account/rateLimits/read",
                Instant::now() + Duration::from_millis(ms),
                || 0,
                clocks,
                clocks.begin(),
            )
        };
        let (tx, rx) = mpsc::channel();
        assert_eq!(wait(&rx, 10, true), Err(FetchError::Suspended));
        assert_eq!(wait(&rx, 10, false), Err(FetchError::Timeout));
        assert_eq!(
            wait(&rx, 0, true),
            Err(FetchError::Suspended),
            "past its deadline"
        );
        // the server's output lost while waiting
        tx.send(Err(FetchError::Disconnected)).unwrap();
        assert_eq!(wait(&rx, 1_000, true), Err(FetchError::Suspended));
        // another failure, or a reply, is what it is
        tx.send(Err(FetchError::Protocol)).unwrap();
        assert_eq!(wait(&rx, 1_000, true), Err(FetchError::Protocol));
        tx.send(Ok(br#"{"id":3,"result":{}}"#.to_vec())).unwrap();
        assert_eq!(wait(&rx, 1_000, true), Ok(json!({})));
        drop(tx);
        assert_eq!(wait(&rx, 1_000, true), Err(FetchError::Suspended));
        assert_eq!(wait(&rx, 1_000, false), Err(FetchError::Disconnected));
    }
}
