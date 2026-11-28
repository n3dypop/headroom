// Headroom for macOS: a notch on the right edge of the screen and a menu bar item, showing the usage limits the Headroom server
// has (read with a read token, every 5 minutes at most). It never touches Claude, Codex or Gemini itself.

import AppKit
import HeadroomKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let app = AppState()
    private var notch: NotchController?
    private var status: StatusItemController?
    private var settings: SettingsWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One notch per sign-in
        let mine = Bundle.main.bundleIdentifier
        let others = NSWorkspace.shared.runningApplications.filter {
            $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
                && ($0.executableURL?.lastPathComponent == "HeadroomBar" || (mine != nil && $0.bundleIdentifier == mine))
        }
        if !others.isEmpty {
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
        app.startReading()
        // Back from sleep: read again when the schedule allows it
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [app] _ in
            app.nudge()
        }
        // First run with nothing set: open Settings
        if app.with({ $0.mode == .setup }) { settings.show() }
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

let application = NSApplication.shared
// No Dock icon: the notch and the menu bar item are the app
application.setActivationPolicy(.accessory)
let delegate = AppDelegate()
application.delegate = delegate
application.run()
