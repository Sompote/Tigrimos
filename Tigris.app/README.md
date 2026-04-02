# Tigris.app

Standalone macOS application that runs **Tiger Cowork** inside a secure Ubuntu sandbox using Apple's Virtualization.framework.

## Security Model

| Layer | Protection |
|-------|-----------|
| **VM Isolation** | Full Ubuntu VM via Virtualization.framework — not a container, a real virtual machine |
| **File System** | Host files completely invisible to VM. Only user-approved folders are shared via VirtioFS |
| **Network** | NAT networking — only port 3001 forwarded. VM can't bind to host interfaces |
| **Permissions** | Shared folders default to read-only. Write requires explicit toggle |
| **Process** | VM processes are invisible to host. Host processes invisible to VM |
| **Audit** | All file access grants/revokes are logged |

## Requirements

- macOS 13.0+ (Ventura or later)
- Apple Silicon (M1/M2/M3/M4) or Intel Mac
- ~4GB RAM available for the VM
- ~20GB disk space (Ubuntu image + Tiger Cowork)

## Build

```bash
# Option 1: Build with Swift Package Manager
cd Tigris.app
swift build -c release

# Option 2: Use the build script (creates .app bundle)
./Scripts/build.sh
```

## First Run

1. Launch Tigris.app
2. Walk through the setup wizard (security acknowledgment)
3. Click "Start Tigris" — downloads Ubuntu 22.04 (~700MB) on first run
4. Wait for provisioning (installs Node.js, Python, Tiger Cowork) — ~5-10 min
5. Tiger Cowork UI loads automatically at `http://localhost:3001`

## Architecture

```
┌─────────────────────────────────────────┐
│            Tigris.app (macOS)           │
│  ┌───────────────────────────────────┐  │
│  │  SwiftUI + WKWebView (port 3001) │  │
│  └───────────────┬───────────────────┘  │
│                  │                      │
│  ┌───────────────▼───────────────────┐  │
│  │    Virtualization.framework       │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │     Ubuntu 22.04 VM        │  │  │
│  │  │  ┌──────────────────────┐  │  │  │
│  │  │  │   Tiger Cowork       │  │  │  │
│  │  │  │   Node.js 20         │  │  │  │
│  │  │  │   Python 3 + venv    │  │  │  │
│  │  │  │   Fastify :3001      │  │  │  │
│  │  │  └──────────────────────┘  │  │  │
│  │  │                            │  │  │
│  │  │  /mnt/shared ←── VirtioFS  │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
│                                         │
│  ~/Tigris_Shared/ (user-controlled)     │
└─────────────────────────────────────────┘
```

## Shared Folders

- Open the **Folders** tab in the app
- Click **Add Folder** → select a macOS folder
- Default: **read-only** (VM can read but not write)
- Toggle to **read-write** if needed (requires VM restart)
- Folders appear inside the VM at `/mnt/shared/<name>`

## Files

```
Tigris.app/
├── Package.swift                    # Swift package manifest
├── Tigris.entitlements             # macOS entitlements (virtualization, network)
├── Tigris/
│   ├── TigrisApp.swift             # App entry point
│   ├── VM/
│   │   ├── VMConfig.swift          # VM configuration constants
│   │   └── VMManager.swift         # VM lifecycle management
│   ├── Views/
│   │   ├── ContentView.swift       # Main app view
│   │   ├── TigerCoworkWebView.swift # WKWebView for Tiger Cowork UI
│   │   ├── ConsoleView.swift       # VM console log viewer
│   │   ├── SharedFoldersView.swift # File sharing UI
│   │   ├── SettingsView.swift      # App settings
│   │   └── SetupView.swift         # First-run wizard
│   ├── Security/
│   │   ├── SandboxManager.swift    # Security-scoped bookmarks
│   │   └── FileAccessControl.swift # File access audit & control
│   └── Resources/
│       ├── provision.sh            # VM provisioning script
│       └── cloud-init.yaml         # Cloud-init config for Ubuntu
└── Scripts/
    ├── build.sh                    # Build .app bundle
    └── setup-vm.sh                 # Manual VM image setup
```
