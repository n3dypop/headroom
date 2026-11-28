//! Keeping the app running: started at sign-in with --keep-running, this process starts the app (this program, without the flag)
//! and waits for it. When the app quits (Quit Headroom, or a second copy finding one already running) it ends too; when the app
//! ends abnormally (a crash, or ended from Task Manager) it starts it again, after a short wait that grows. Restarts that come too
//! often end it: a crash at every start isn't repeated for ever. It has no window and reads nothing itself.

use std::time::{Duration, Instant};

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

/** The watcher's memory: when the app was started again, and how many abnormal ends in a row */
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
        self.restarts.retain(|&at| now.duration_since(at) < WINDOW);
        if self.restarts.len() >= MAX_RESTARTS {
            return Next::Stop;
        }
        let wait = WAITS[self.in_a_row.min(WAITS.len() - 1)];
        self.in_a_row += 1;
        self.restarts.push(now);
        Next::Restart(Duration::from_secs(wait))
    }
}

/** Starts the app and keeps it running, as above */
pub fn run() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut watch = Watch::default();
    loop {
        let started = Instant::now();
        let ended = std::process::Command::new(&exe).status();
        // Not started at all: nothing to keep running
        let Ok(status) = ended else { return };
        match watch.after(status.success(), started.elapsed(), Instant::now()) {
            Next::Stop => return,
            Next::Restart(wait) => std::thread::sleep(wait),
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
        assert_eq!(w.after(false, s(1), t + s(10)), Next::Restart(s(15)));
        assert_eq!(w.after(false, s(1), t + s(30)), Next::Restart(s(60)));
        // A long run in between: from the first wait again
        assert_eq!(
            w.after(false, s(20 * 60), t + s(21 * 60)),
            Next::Restart(s(5))
        );
    }

    #[test]
    fn too_many_restarts_stop_it() {
        let t = Instant::now();
        let mut w = Watch::default();
        let s = Duration::from_secs;
        for n in 0..5 {
            assert!(matches!(
                w.after(false, s(1), t + s(n * 10)),
                Next::Restart(_)
            ));
        }
        assert_eq!(
            w.after(false, s(1), t + s(60)),
            Next::Stop,
            "a 6th within 30 minutes"
        );
        // Later, the old ones no longer count
        let mut w = Watch::default();
        for n in 0..5 {
            w.after(false, s(1), t + s(n * 10));
        }
        assert!(matches!(
            w.after(false, s(1), t + s(40 * 60)),
            Next::Restart(_)
        ));
    }
}
