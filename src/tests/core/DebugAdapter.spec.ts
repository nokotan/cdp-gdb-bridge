import { DebugClient } from "@vscode/debugadapter-testsupport";
import { DebugProtocol } from '@vscode/debugprotocol';

let dc: DebugClient;

beforeAll(() => {
    dc = new DebugClient('node', 'dist/vscode/dapServerLauncher.js', 'wasm-node', undefined, true);
    return dc.start();
});

afterAll(() => {
    dc.stop();
})

test('should run program to the end', () => {
    return Promise.all([
        dc.initializeRequest(),
        new Promise(resolve => {
            dc.once("terminated", resolve);
            dc.send("launch", { program: "tests/app/Main.js", type: "wasm-node", port: 19222 });
        })
    ]);
});

test('should hit breakpoint', () => {
    const breakPoint = {
        path: "/Volumes/SHARED/Visual Studio 2017/EmscriptenTest/Main.cpp",
        line: 3
    };
    return Promise.all([
        dc.initializeRequest(),
        dc.setBreakpointsRequest(
            { 
                lines: [ breakPoint.line ],
                source: { path: breakPoint.path },
                breakpoints: [ { line: breakPoint.line } ] 
            }),
        new Promise<void>(resolve => {
            dc.once("stopped", response => {
                console.log(response);
                resolve();
            });
            dc.send("launch", { program: "tests/app/Main.js", type: "wasm-node", port: 19222 });
        })     
    ]);
});
