//! `headroom credentials set` reads one piped line (only direct input from a terminal is refused).
//! The check uses a token that is too short, so the OS credential store is never touched.

use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn credentials_set_reads_a_piped_line_and_never_echoes_it() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_headroom"))
        .args(["credentials", "set"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("headroom starts");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(b"short-input\n")
        .expect("writable");
    let out = child.wait_with_output().expect("exits");
    assert_eq!(
        out.status.code(),
        Some(2),
        "fewer than 16 characters is not saved"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stderr.contains("first line must be the Worker token"),
        "{stderr}"
    );
    assert!(
        !stderr.contains("Direct input from a terminal"),
        "a pipe is not refused: {stderr}"
    );
    assert!(
        !stderr.contains("short-input") && !stdout.contains("short-input"),
        "the input is never shown"
    );
}
