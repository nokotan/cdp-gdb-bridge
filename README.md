# cdp-gdb-bridge

WebAssembly on Chrome cli debugger

## Usage

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

## Supported Commands

| Syntax | |
|:--:|:--:|
| b (FileName):(LineNumber| Set Breakpoint |
| n | Step-Over |
| s | Step-In |
| u | Step-Out |
| c | Continue |
| i | Show Local Variables Name |
| p (VariableName) | Evaluate Local Variable |

## Known Issues

- Some WebAssembly Files with **name** Sections cannot be parsed.
