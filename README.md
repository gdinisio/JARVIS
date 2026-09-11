<div align="center">

# JARVIS

**Just A Really Very Intelligent System**

An intelligent layer that sits on top of your computer — understands natural language,
plans multi-step work, and carries it out through a fixed set of audited tools.

Windows 11 · macOS · Linux

</div>

<img src="docs/images/command.png" alt="The JARVIS command screen: system HUD, the core, and a live activity console" width="100%">

---

## What it is

JARVIS is a desktop AI assistant, not a chat window. You speak or type a request;
it works out what you mean, decides which tools to use, asks before anything
consequential, performs the work on the actual operating system, and tells you
what happened.

```
"How is my system doing?"          → reads live CPU, memory, disk, battery
"Open my development environment"  → resolves your preferences, launches, reports
"Find the PDFs in Downloads"       → bounded filesystem search, ranked by date
"Clean up my desktop"              → shows the plan, waits for [EXECUTE]
"Delete these files"               → names every file, waits for confirmation
"Remember my browser is Firefox"   → stored, visible and removable in Memory
"Start work"                       → runs the routine you saved, offline
```

It never executes model-generated code. The model can only propose a call to one
of the tools listed in [Tools](#tools); a security layer validates the arguments
and decides whether it runs, needs confirmation, or is refused.

<table>
<tr>
<td width="50%"><img src="docs/images/boot.png" alt="Startup sequence reporting real subsystem state" width="100%"><br><sub><b>Startup</b> — diagnostics report what is actually true; no key means <code>NO KEY</code>, not <code>READY</code>.</sub></td>
<td width="50%"><img src="docs/images/confirmation.png" alt="Confirmation dialog naming exactly what will happen" width="100%"><br><sub><b>The gate</b> — nothing consequential happens without this, and Cancel holds focus.</sub></td>
</tr>
</table>

---

## The stack, and why

| Layer | Choice | Reason |
|---|---|---|
| Shell | **Electron** | Native tray/menu-bar, global shortcuts, screen capture and OS-encrypted credential storage all exist as first-class APIs on both Windows and macOS. Tauri would be leaner, but the automation layer — process enumeration, metrics, app discovery — is far more mature in Node, and a Rust toolchain is a real barrier for contributors on both platforms. |
| Language | **TypeScript**, strict everywhere | The main↔renderer contract is the security boundary; it should be checked by a compiler. |
| Interface | **React + Vite** | Fast HMR during development; the interface is state-driven, not document-driven. |
| Core visual | **Canvas 2D** | One animation loop, no DOM churn, no WebGL context to lose. Three.js would cost more than the design needs. |
| Audio | **Web Audio + MediaRecorder** | Real analyser data drives the core's waveform, rather than a decorative animation. |
| Speech in | **Groq Whisper** (`whisper-large-v3-turbo`) | Latency is what you feel in a voice assistant, and Groq is the fastest path from audio to text. |
| Speech out | **OS voices** via Web Speech, with `say` / SAPI as fallback | No cloud round-trip, and `boundary` events let the core pulse with the actual speech. |
| Metrics | **systeminformation** | One cross-platform API for CPU, memory, GPU, disks, network and battery. |
| Validation | **zod** | One schema per tool: runtime validation *and* the JSON Schema published to the model. |

---

## Architecture

```
                    Voice ─┐
                           ├──► Engine ──► AI provider (Claude │ Groq)
                    Text ──┘       │              │
                                   │              ▼
                                   │        structured tool call
                                   ▼              │
                            ┌──────────────────────────────┐
                            │      SECURITY LAYER          │
                            │  schema · paths · commands   │
                            │  risk · permissions · confirm│
                            └──────────────┬───────────────┘
                                           ▼
                              Platform abstraction (one interface)
                                  ┌────────┼────────┐
                              Windows    macOS     Linux
                                  └────────┼────────┘
                                           ▼
                                   Operating system
                                           │
                            result ────────┴──► Engine ──► voice + interface
```

Nothing above the platform layer knows which operating system it is running on.
`src/main/platform/index.ts` is the only place that branches on `process.platform`.

```
src/
  main/                    privileged process — holds every secret
    core/
      ai/                  AIProvider, ClaudeProvider, GroqProvider, AUTO router
      engine.ts            request loop, tool calls, plans, routines
      permissions.ts       risk classification and the confirmation gate
      memory.ts            long-term preferences
      routines.ts          saved multi-step sequences
      intent.ts            offline command matching (works with no model)
    tools/
      descriptors.ts       the catalogue: schema + risk + description
      validate.ts          path, URL and command validation (pure, unit-tested)
      registry.ts          validate → execute → log
      filesystem · applications · system · web · screen · terminal · power
    platform/
      windows.ts · macos.ts · linux.ts · exec.ts (argument-array spawn)
    services/              monitoring, logging, secrets, settings, history, …
    windows/               window, tray, global hotkeys
  preload/                 the only bridge; a fixed list of channels
  renderer/                interface — never sees a key, never touches the OS
  shared/                  types, defaults and IPC names used by both sides
tests/                     172 tests, security paths first
```

---

## Running it

```bash
npm install
cp .env.example .env      # add your keys, or configure them in Settings → AI
npm run dev               # development, with hot reload
npm run build && npm start
```

Packaging:

```bash
npm run dist:win          # NSIS installer, x64 + arm64
npm run dist:mac          # DMG, x64 + arm64
npm run dist:linux        # AppImage
```

Verification:

```bash
npm test                  # unit tests
npm run smoke             # launches the real app, drives it, captures screenshots
npm run typecheck
```

`npm run smoke` boots the application in a disposable data directory, runs the
tool layer against real files, confirms that traversal, shell injection and
dangerous URL schemes are refused, checks that the confirmation gate appears and
that approving it actually performs the action, and writes a screenshot of every
screen to `screenshots/`.

### If `npm run dev` says `Error: Electron uninstall`

`npm install` downloads the Electron binary from a postinstall script, which is
skipped when `ignore-scripts` is set and can fail quietly behind a proxy or
corporate firewall. electron-vite then reports the missing binary with that
rather unhelpful message.

Every `dev`, `start` and `build` run now checks for the binary first and fetches
it if it is missing, so this should repair itself. To do it by hand:

```bash
node node_modules/electron/install.js
```

If the download itself is being blocked:

```bash
npm config set proxy http://your-proxy:port          # behind a proxy
npm config set https-proxy http://your-proxy:port

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # or use a mirror
node node_modules/electron/install.js
```

**No keys?** JARVIS still runs. It falls back to offline command matching for
direct instructions ("open Chrome", "what's my CPU usage", "create a folder
called Projects"), and Demo Mode shows the entire interface with nothing
executed and everything clearly labelled.

---

## Voice

| Mode | How |
|---|---|
| Click to talk | The microphone button. Speak; it stops on silence. |
| Hold to talk | Hold `Ctrl/Cmd+Shift+Space` while the window has focus. |
| Global shortcut | `Ctrl+Space` (Windows) / `Cmd+Space` (macOS) from any application. |
| Wake word | Optional. Say "Hey JARVIS". |
| Text | Always available. |

The microphone is opened only while JARVIS is listening, and the title bar shows
`MIC OPEN` for exactly as long as it is. Wake-word detection works by watching
for speech locally and transcribing short clips to recognise the phrase — it is
off by default, and the indicator reads `WAKE` whenever it is armed.

Say "stop" — or press `Esc` — and JARVIS stops talking immediately.

> On macOS, `Cmd+Space` belongs to Spotlight until you free it in System
> Settings → Keyboard → Shortcuts. JARVIS reports the clash rather than failing
> silently, and the shortcut is configurable.

---

## Security

The model proposes; it never disposes.

**Risk classification.** Every tool is low, medium or high risk. Low risk runs
automatically (opening an app, reading metrics). Medium risk confirms by default
(moving files, changing settings). High risk *always* confirms and cannot be
configured not to — deleting, running a command, restarting, shutting down.

**Path validation.** Model-supplied paths are expanded, resolved, and checked
against protected locations (system directories, credential stores, browser
profiles) and allowed roots before any filesystem call. Traversal, UNC paths,
Windows device names and NUL bytes are refused. Windows rules are evaluated with
Windows path semantics even when the checks run elsewhere.

**Command execution.** JARVIS never spawns a shell. Programs are launched with an
argument vector, so `;`, `&&`, backticks and `$(…)` inside a value are inert
data. The program itself must be on an allow-list, shell interpreters are
refused outright, and every call requires explicit confirmation. PowerShell and
AppleScript are driven by static scripts with dynamic values passed through
environment variables — never string-interpolated.

**Secrets.** API keys live in the main process only, in OS-encrypted storage
(`safeStorage`) or the environment. The renderer can set and clear a key but can
never read one back, and the log writer redacts anything key-shaped before it
reaches disk.

**Process isolation.** Context isolation on, node integration off, sandbox on,
a strict CSP, an explicit IPC channel list, and a permission handler that grants
the microphone to our own window and nothing else.

---

## Tools

| Category | Tools | Risk |
|---|---|---|
| Applications | `open_application` `close_application` `list_applications` | low – medium |
| Files | `search_files` `get_file_info` `read_text_file` `open_path` | low – medium |
| | `create_folder` `create_file` `move_file` `copy_file` `rename_file` | medium |
| | `delete_file` | **high** |
| System | `get_system_stats` `get_running_processes` `open_settings` `set_volume` | low – medium |
| Web | `open_url` `web_search` | low |
| Screen | `take_screenshot` `read_screen` | medium, opt-in |
| Terminal | `execute_command` | **high** |
| Power | `lock_computer` `restart_computer` `shutdown_computer` | medium – **high**, opt-in |
| Memory | `remember` `forget` `recall` | low |
| Routines | `create_routine` `run_routine` `list_routines` `delete_routine` | low – medium |

Plus `present_plan`, which touches nothing: it declares what JARVIS intends to do
so you can see the plan — and approve it — before the first real action runs.

Every tool can be set to **always allow**, **always confirm** or **never** in
Settings → Permissions.

<img src="docs/images/permissions.png" alt="Per-tool permission policy in Settings" width="100%">

---

## Privacy

- Requests go to the provider you configure (Anthropic or Groq) with the system
  metrics and tool results needed to answer them. Voice audio goes to Groq for
  transcription. Nothing else is transmitted.
- No telemetry, no analytics, no account.
- Memory, routines, history, settings and logs are plain JSON in your OS
  application-data directory, or wherever `JARVIS_DATA_DIR` points.
- Everything JARVIS remembers is listed on the Memory screen and can be deleted
  there, individually or all at once.

---

## Keyboard

| | |
|---|---|
| `Ctrl/Cmd + K` | Focus the command bar |
| `Ctrl/Cmd + 1…5` | Command · Routines · Memory · History · Settings |
| `Ctrl/Cmd + Shift + L` | Start listening |
| `Ctrl/Cmd + Shift + Space` | Hold to talk |
| `Enter` / `Shift + Enter` | Send / new line |
| `↑` `↓` | Command history |
| `Esc` | Stop speaking, cancel the request, or leave the current screen |

---

## Licence

MIT.
