//! Keeping the app running: started at sign-in with --keep-running, this process starts the app (this program, without the flag)
//! and waits for it. When the app quits (Quit Headroom, or a second copy finding one already running) it ends too; when the app
//! ends abnormally (a crash, or ended from Task Manager) it starts it again, after a short wait that grows. Restarts that come too
//! often end it: a crash at every start isn't repeated for ever. One watcher per sign-in; a Quit from any copy of the app, also one
//! started by hand while the watcher waits, ends it. It has no window and reads nothing itself.

use std::time::{Duration, Instant};
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
};

/** The argument the Run key gives */
pub const FLAG: &str = "--keep-running";

/** Waits before the next start: after the 1st, 2nd, 3rd... abnormal end in a row */
const WAITS: [u64; 4] = [5, 15, 60, 300];
/** At most this many restarts in this long; past it the watcher stops (and the app stays down until the next sign-in) */
const MAX_RESTARTS: usize = 5;
const WINDOW: Duration = Duration::from_secs(30 * 60);
/** A run this long counts as having worked: the waits start again from the first */
const STEADY: Duration = Duration::from_secs(10 * 60);

/** What to do after the app ended: stop, or start it again after a wait */
#[derive(Debug, PartialEq)]
enum Next {
    Stop,
    Restart(Duration),
}

/** The watcher's memory: when it started the app again, and how many abnormal ends in a row */
#[derive(Default)]
struct Watch {
    restarts: Vec<Instant>,
    in_a_row: usize,
}

impl Watch {
    /** After the app ended (`ok`: a normal end) having run for `ran`, at `now` */
    fn after(&mut self, ok: bool, ran: Duration, now: Instant) -> Next {
        if ok {
            return Next::Stop;
        }
        if ran >= STEADY {
            self.in_a_row = 0;
        }
        // Counted from the restarts themselves: one more must keep within the limit over the window
        self.restarts.retain(|&at| now.duration_since(at) < WINDOW);
        if self.restarts.len() >= MAX_RESTARTS {
            return Next::Stop;
        }
        let wait = WAITS[self.in_a_row.min(WAITS.len() - 1)];
        self.in_a_row += 1;
        Next::Restart(Duration::from_secs(wait))
    }

    /** The app was started again, at `at` */
    fn restarted(&mut self, at: Instant) {
        self.restarts.push(at);
    }
}

/** Tells the watcher that the app was quit (Quit Headroom): it doesn't start the app again. Nothing when there is no watcher */
pub fn quit() {
    unsafe {
        if let Ok(event) = OpenEventW(EVENT_MODIFY_STATE, false, w!("Local\\HeadroomDesktopQuit")) {
            let _ = SetEvent(event);
            let _ = CloseHandle(event);
        }
    }
}

/** Starts the app and keeps it running, as above */
pub fn run() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    unsafe {
        // One watcher per sign-in
        let Ok(_single) = CreateMutexW(None, true, w!("Local\\HeadroomDesktopKeep")) else {
            return;
        };
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return;
        }
        // Set by a Quit in any copy of the app (manual reset: it stays set)
        let Ok(quit) = CreateEventW(None, true, false, w!("Local\\HeadroomDesktopQuit")) else {
            return;
        };
        let quitted = |ms: u32| WaitForSingleObject(quit, ms) == WAIT_OBJECT_0;
        let mut watch = Watch::default();
        loop {
            let started = Instant::now();
            let ended = std::process::Command::new(&exe).status();
            // Not started at all: nothing to keep running
            let Ok(status) = ended else { return };
            match watch.after(status.success(), started.elapsed(), Instant::now()) {
                Next::Stop => return,
                Next::Restart(wait) => {
                    // A Quit meanwhile (from a copy started by hand) ends the watcher instead
                    if quitted(wait.as_millis() as u32) {
                        return;
                    }
                    watch.restarted(Instant::now());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quit_ends_it_and_a_crash_starts_the_app_again_with_growing_waits() {
        let t = Instant::now();
        let mut w = Watch::default();
        assert_eq!(w.after(true, Duration::ZERO, t), Next::Stop);
        let s = Duration::from_secs;
        assert_eq!(w.after(false, s(1), t), Next::Restart(s(5)));
        w.restarted(t + s(5));
        assert_eq!(w.after(false, s(1), t + s(10)), Next::Restart(s(15)));
        w.restarted(t + s(25));
        assert_eq!(w.after(false, s(1), t + s(30)), Next::Restart(s(60)));
        w.restarted(t + s(90));
        // A long run in between: from the first wait again
        assert_eq!(
            w.after(false, s(20 * 60), t + s(21 * 60)),
            Next::Restart(s(5))
        );
    }

    #[test]
    fn at_most_five_restarts_in_any_thirty_minutes() {
        let t = Instant::now();
        let s = Duration::from_secs;
        let mut w = Watch::default();
        for n in 0..5 {
            assert!(matches!(
                w.after(false, s(1), t + s(n * 100)),
                Next::Restart(_)
            ));
            w.restarted(t + s(n * 100 + 50));
        }
        assert_eq!(
            w.after(false, s(1), t + s(600)),
            Next::Stop,
            "a 6th within 30 minutes of the first restart"
        );
        // Once the first restart is 30 minutes back, one more may come
        let mut w = Watch::default();
        for n in 0..5 {
            w.after(false, s(1), t + s(n * 100));
            w.restarted(t + s(n * 100 + 50));
        }
        assert!(matches!(
            w.after(false, s(1), t + s(50 + 30 * 60)),
            Next::Restart(_)
        ));
    }
}
