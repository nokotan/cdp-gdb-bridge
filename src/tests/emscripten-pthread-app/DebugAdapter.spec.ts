import { DebugClient } from "@vscode/debugadapter-testsupport";
import { killAll } from "chrome-launcher";

let dc: DebugClient;

beforeAll(() => {
    dc = new DebugClient('node', 'dist/vscode/dapServerLauncher.js', 'wasm-node', undefined, true);
    return dc.start();
});

afterAll(async () => {
    await dc.stop();
    await killAll();
})

test('should run program to the end', () => {
    return Promise.all([
        dc.waitForEvent("terminated"),
        dc.launch({ program: "tests/emscripten-pthread-app/Main.js", type: "wasm-node", port: 19401 })
    ]);
}, 20000);

//
// nodejs worker debugging is disabled for lacking cdp target api.
//

// test('should capture log', async () => {
//     await dc.launch({ program: "tests/emscripten-pthread-app/Main.js", type: "wasm-node", port: 19401 });
//     await dc.assertOutput("stdout", "Hei\n");
//     await Promise.all([           
//         dc.waitForEvent("terminated"),
//         dc.terminateRequest({})
//     ]);
// }, 20000);

// test('should hit breakpoint', async () => {
//     const breakPoint = {
//         path: "c:/emscripten-simple-app/Main.cpp",
//         line: 4
//     };
//     await Promise.all([
//         dc.waitForEvent("initialized"),
//         dc.initializeRequest()
//     ]);
//     await dc.setBreakpointsRequest({ 
//         lines: [ breakPoint.line ],
//         source: { path: breakPoint.path },
//         breakpoints: [ { line: breakPoint.line } ] 
//     });
//     await Promise.all([
//         dc.assertStoppedLocation("BreakPointMapping", breakPoint),
//         dc.send("launch", { program: "tests/emscripten-pthread-app/Main.js", type: "wasm-node", port: 19402 })
//     ]);
//     await Promise.all([           
//         dc.waitForEvent("terminated"),
//         dc.terminateRequest({})
//     ]);
// }, 20000);

// test('should step line by line', async () => {
//     const breakPoint = {
//         path: "c:/emscripten-simple-app/Main.cpp",
//         line: 4
//     };
  
//     await Promise.all([
//         dc.waitForEvent("initialized"),
//         dc.initializeRequest()
//     ]);
//     await dc.setBreakpointsRequest({ 
//         lines: [ breakPoint.line ],
//         source: { path: breakPoint.path },
//         breakpoints: [ { line: breakPoint.line } ] 
//     });
//     await Promise.all([
//         dc.waitForEvent("stopped"),
//         dc.send("launch", { program: "tests/emscripten-pthread-app/Main.js", type: "wasm-node", port: 19403 })
//     ]);
//     await Promise.all([           
//         dc.assertStoppedLocation("BreakPointMapping", {
//             path: breakPoint.path,
//             line: breakPoint.line + 1
//         }),
//         dc.nextRequest({ threadId: 1 })
//     ]);
//     await Promise.all([           
//         dc.waitForEvent("terminated"),
//         dc.terminateRequest({})
//     ]);
// }, 20000);
