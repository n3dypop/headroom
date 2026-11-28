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

    let argv: [UnsafeMutablePointer<CChar>?] = ([path] + args.dropFirst()).map { strdup($0) } + [nil]
    var copy = env
    copy[DETACHED] = "1"
    let envp: [UnsafeMutablePointer<CChar>?] = copy.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer {
        argv.forEach { free($0) }
        envp.forEach { free($0) }
    }
    var pid: pid_t = 0
    let started = posix_spawn(&pid, path, &files, &attr, argv, envp)
    if started == 0 {
        print("Headroom is running in the background (process \(pid)). Quit it from its menu bar item.")
        exit(0)
    }
    // Not started: this one goes on in the terminal (the hang-up is ignored)
    FileHandle.standardError.write("Couldn't start in the background; running here (closing the terminal won't end it)\n".data(using: .utf8)!)
}
