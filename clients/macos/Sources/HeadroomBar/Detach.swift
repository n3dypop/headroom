// Started from a terminal, the app goes on by itself: it starts a copy of itself in a session of its own (no terminal, its output
// to /dev/null) and the first one ends, so closing the terminal, or ending the shell, doesn't end the app. `--foreground` keeps it
// in the terminal (its messages show there). Started any other way (launchd, Finder) it runs as it is.

import Darwin
import Foundation

/** Set in the copy started in the background, so it doesn't start another */
private let DETACHED = "HEADROOM_DESKTOP_DETACHED"

/** Whether this process has a terminal on any of its standard streams */
private func onTerminal() -> Bool {
    isatty(STDIN_FILENO) != 0 || isatty(STDOUT_FILENO) != 0 || isatty(STDERR_FILENO) != 0
}

/** Starts the copy in the background and ends this one, when started from a terminal. When the copy can't be started, this one
 * goes on, ignoring the hang-up a closing terminal sends */
func detachFromTerminal() {
    // A closing terminal hangs up the processes it started: never the end of the app
    signal(SIGHUP, SIG_IGN)
    let args = CommandLine.arguments
    let env = ProcessInfo.processInfo.environment
    if args.contains("--foreground") || env[DETACHED] != nil || !onTerminal() { return }
    guard let path = Bundle.main.executablePath else { return }

    var attr: posix_spawnattr_t?
    var files: posix_spawn_file_actions_t?
    guard posix_spawnattr_init(&attr) == 0 else { return }
    defer { posix_spawnattr_destroy(&attr) }
    guard posix_spawn_file_actions_init(&files) == 0 else { return }
    defer { posix_spawn_file_actions_destroy(&files) }
    // A session of its own (no controlling terminal); the hang-up stays ignored in it, as ignored signals carry over
    guard posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID)) == 0 else { return }
    for fd in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
        let flags = fd == STDIN_FILENO ? O_RDONLY : O_WRONLY
        guard posix_spawn_file_actions_addopen(&files, fd, "/dev/null", flags, 0) == 0 else { return }
    }

    var copy = env
    copy[DETACHED] = "1"
    let argStrings = [path] + args.dropFirst()
    let envStrings = copy.map { "\($0.key)=\($0.value)" }
    let argv: [UnsafeMutablePointer<CChar>?] = argStrings.map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = envStrings.map { strdup($0) } + [nil]
    defer {
        argv.forEach { free($0) }
        envp.forEach { free($0) }
    }
    // A copy that couldn't be made (no memory) would cut the lists short: this one goes on instead
    if argv.dropLast().contains(where: { $0 == nil }) || envp.dropLast().contains(where: { $0 == nil }) { return }
    var pid: pid_t = 0
    let started = posix_spawn(&pid, path, &files, &attr, argv, envp)
    if started == 0 {
        // Only that it was started: it may still end at once (Headroom already running)
        say("Started Headroom in the background (process \(pid)). If it was running already, that one goes on. Quit it from its menu bar item.\n", to: STDOUT_FILENO)
        exit(0)
    }
    // Not started: this one goes on in the terminal (the hang-up is ignored)
    say("Couldn't start in the background; running here (closing the terminal won't end it)\n", to: STDERR_FILENO)
}

/** Writes a line to a standard stream, ignoring any failure (a closed stream must never stop the app) */
private func say(_ text: String, to fd: Int32) {
    let bytes = Array(text.utf8)
    _ = bytes.withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
}
