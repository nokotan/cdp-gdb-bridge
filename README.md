# WebAssembly on Chrome Debugger

WebAssembly on Chrome cli debugger & vscode extension

## Command Line Interface

### Install

```sh
npm i cdp-gdb-bridge
```

### Usage

```sh
# Launch Chrome & Debugging Proxy
> cdp-gdb-bridge

# And then, open the debugged url in launched chrome.
Page navigated.
http://localhost:8080/index.wasm
Start Loading http://localhost:8080/index.wasm...

# Now you can use debug commands like gdb
> b Main.cpp:10
```

### Supported Commands

| Syntax | |
|:--:|:--:|
| r (url) | Jump to url |
| b (FileName):(LineNumber) | Set Breakpoint |
| d (breakpoint ID | Delete Breakpoint |
| n | Step-Over |
| s | Step-In |
| u | Step-Out |
| c | Continue |
| l | Show Source File around Current Frame |
| il | Show Local Variables Name |
| ig | Show Global Variables Name |
| p (VariableName) | Evaluate Variable |

## VSCode Extension

### Install

Visual Studio Marketplace: <https://marketplace.visualstudio.com/items?itemName=KamenokoSoft.cdp-gdb-bridge>

### Support Status

|| Windows | macOS | Linux |
| :--: | :--: | :--: | :--: |
| Chrome | ✅ | ✅ | ✅ |
| FireFox | ❌ | ❌ | ❌ |
| Safari | - | ❌ | - |
| Edge | ❌ | - | - |

### Features

- BreakPoints
- Variable Dump
