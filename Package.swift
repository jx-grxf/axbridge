// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AXBridge",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "AXBridge", targets: ["AXBridge"]),
    ],
    targets: [
        .target(name: "AXBridge"),
        .testTarget(name: "AXBridgeTests", dependencies: ["AXBridge"]),
    ]
)
