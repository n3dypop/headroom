// swift-tools-version:5.10
// Headroom for macOS: a notch on the right edge of the screen and a menu bar item, showing the usage limits the Headroom server
// has (read with a read token). HeadroomKit holds what can be tested anywhere (the widget's display rules, the schedule, the
// settings); HeadroomBar is the app.
import PackageDescription

let package = Package(
    name: "HeadroomBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "HeadroomBar", targets: ["HeadroomBar"]),
    ],
    targets: [
        .target(name: "HeadroomKit"),
        .executableTarget(name: "HeadroomBar", dependencies: ["HeadroomKit"]),
        .testTarget(name: "HeadroomKitTests", dependencies: ["HeadroomKit"]),
    ]
)
