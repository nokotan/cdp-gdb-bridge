import { DebugClient } from "@vscode/debugadapter-testsupport";

let dc: DebugClient;

beforeAll(() => {
    dc = new DebugClient('node', 'dist/vscode/dapServerLauncher.js', 'wasm-node', undefined, true);
    return dc.start();
});

afterAll(() => {
    void dc.stop();
})

test('should run program to the end', () => {
    return Promise.all([
        dc.waitForEvent("terminated"),
        dc.launch({ program: "tests/emscripten-simple-app/Main.js", type: "wasm-node", port: 19201 })
    ]);
});

test('should hit breakpoint', async () => {
    const breakPoint = {
        path: "c:/emscripten-simple-app/Main.cpp",
        line: 3
    };
    await Promise.all([
        dc.waitForEvent("initialized"),
        dc.initializeRequest()
    ]);
    await dc.setBreakpointsRequest({ 
        lines: [ breakPoint.line ],
        source: { path: breakPoint.path },
        breakpoints: [ { line: breakPoint.line } ] 
    });
    await Promise.all([
        dc.assertStoppedLocation("BreakPointMapping", breakPoint),
        dc.send("launch", { program: "tests/emscripten-simple-app/Main.js", type: "wasm-node", port: 19202 })
    ]);
    await Promise.all([           
        dc.waitForEvent("terminated"),
        dc.terminateRequest({})
    ]);
});

test('should step line by line', async () => {
    const breakPoint = {
        path: "c:/emscripten-simple-app/Main.cpp",
        line: 3
    };
  
    await Promise.all([
        dc.waitForEvent("initialized"),
        dc.initializeRequest()
    ]);
    await dc.setBreakpointsRequest({ 
        lines: [ breakPoint.line ],
        source: { path: breakPoint.path },
        breakpoints: [ { line: breakPoint.line } ] 
    });
    await Promise.all([
        dc.waitForEvent("stopped"),
        dc.send("launch", { program: "tests/emscripten-simple-app/Main.js", type: "wasm-node", port: 19202 })
    ]);
    await Promise.all([           
        dc.assertStoppedLocation("BreakPointMapping", {
            path: breakPoint.path,
            line: breakPoint.line + 1
        }),
        dc.nextRequest({ threadId: 0 })
    ]);
    await Promise.all([           
        dc.waitForEvent("terminated"),
        dc.terminateRequest({})
    ]);
});
