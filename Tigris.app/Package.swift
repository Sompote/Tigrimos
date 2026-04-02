// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TigrimOS",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "TigrimOS",
            path: "TigrimOS",
            resources: [
                .copy("Resources/provision.sh"),
                .copy("Resources/cloud-init.yaml"),
            ],
            linkerSettings: [
                .linkedFramework("Virtualization"),
            ]
        ),
    ]
)
