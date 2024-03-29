# WebAssembly on Chrome Debugger

WebAssembly Debugger for Google Chrome, node.js

## CLI

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

### Implemented Features

- BreakPoints
- Variable Value Inspection

### Support Status

| | Windows | macOS | Linux | Support Version |
| :--: | :--: | :--: | :--: | :--: |
| node.js | ✅ | ✅ | ✅ | v16.0+, no workers debugging support |
| Chrome | ✅ | ✅ | ✅ | v64+ |
| FireFox | ❌ | ❌ | ❌ | |
| Safari | - | ❌ | - | |
| Edge | ❌ | - | - | |
