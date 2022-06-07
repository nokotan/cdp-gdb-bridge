import { DebugClient } from "@vscode/debugadapter-testsupport";
import { DebugProtocol } from '@vscode/debugprotocol';

let dc: DebugClient;

beforeAll(() => {
    dc = new DebugClient('node', 'dist/vscode/dapServerLauncher.js', 'wasm-node');
    return dc.start();
});

afterAll(() => {
    dc.stop();
})

test('should run program to the end', () => {
    return Promise.all([
        dc.launch({ program: "tests/app/Main.js", type: "wasm-node", port: 19222 }),
        dc.waitForEvent('terminated')
    ]);
});

test('should hit breakpoint', () => {
    const breakPoint = {
        path: "/Volumes/SHARED/Visual Studio 2017/EmscriptenTest/Main.cpp",
        line: 4
    };
    return Promise.all([
        dc.setBreakpointsRequest(
            { 
                source: { path: breakPoint.path },
                breakpoints: [ { line: breakPoint.line } ] 
            }),
        dc.launch({ program: "tests/app/Main.js", type: "wasm-node", port: 19222 }),
        dc.waitForEvent('stopped')         
    ]);
}, 10000);
