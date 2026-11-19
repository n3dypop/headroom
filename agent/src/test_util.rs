//! Helpers shared by the unit tests (compiled for tests only).

use std::ops::Deref;
use std::path::{Path, PathBuf};

/// A fresh folder under the system temp folder, removed when dropped (also when the test fails), so test runs
/// leave nothing behind
pub struct TempHome(PathBuf);

impl TempHome {
    /// `name` names the folder; the process ID keeps parallel test runs apart
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Deref for TempHome {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

impl AsRef<Path> for TempHome {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
