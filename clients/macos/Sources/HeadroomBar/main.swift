// Headroom for macOS: a notch on the right edge of the screen and a menu bar item, showing the usage limits the Headroom server
// has (read with a read token, every 5 minutes at most). It never touches Claude, Codex or Gemini itself.

import AppKit
import HeadroomKit

/** One app per sign-in: an exclusive lock on a file of the user's own, held until the app ends (the system lets it go then) */
private func takeTheLock() -> Bool {
    guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("Headroom")
    else { return true }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let fd = open(dir.appendingPathComponent("desktop.lock").path, O_CREAT | O_RDWR, 0o600)
    if fd < 0 { return true }
    // Kept open on purpose: the lock lasts as long as the process
    return flock(fd, LOCK_EX | LOCK_NB) == 0
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private lazy var app = AppState()
    private var notch: NotchController?
    private var status: StatusItemController?
    private var settings: SettingsWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One notch per sign-in, decided before anything reads or writes the settings
        if !takeTheLock() {
            NSApp.terminate(nil)
            return
        }
        installEditMenu()
        let settings = SettingsWindowController(app: app)
        self.settings = settings
        let status = StatusItemController(app: app)
        status.openSettings = { settings.show() }
        self.status = status
        // HEADROOM_DESKTOP_OPEN=1 keeps the notch open with its first card (for checking the look without the pointer)
        let notch = NotchController(app: app, pinned: ProcessInfo.processInfo.environment["HEADROOM_DESKTOP_OPEN"] != nil)
        notch.onTray = { status.set($0) }
        self.notch = notch
        app.onChange = { [weak notch] in notch?.refresh() }
        // A change in the settings' Placement, Appearance or Behavior: placed and drawn again at once
        app.onPrefs = { [weak notch] in notch?.applyPrefs() }
        // The icons the settings read when they open (both sets), for the notch too
        settings.onIcons = { [weak notch] in notch?.setIcons($0) }
        app.startReading()
        // Back from sleep: read again when the schedule allows it
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [app] _ in
            app.nudge()
        }
        // First run with nothing set: open Settings
        if app.with({ $0.mode == .setup }) { settings.show() }
    }

    /** Quitting waits for the settings queue: a change shown as set is in the file when the app ends (only once the app has its state;
     * a second copy that quits at once never made one) */
    func applicationWillTerminate(_ notification: Notification) {
        if settings != nil { app.finishSaving() }
    }

    /** Copy, paste and select all in the settings fields (an app without a Dock icon has no menu bar of its own) */
    private func installEditMenu() {
        let main = NSMenu()
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }
}

// Started from a terminal: on by itself, so closing the terminal doesn't end it (before anything else, the lock included)
detachFromTerminal()

let application = NSApplication.shared
// No Dock icon: the notch and the menu bar item are the app
application.setActivationPolicy(.accessory)
let delegate = AppDelegate()
application.delegate = delegate
application.run()
