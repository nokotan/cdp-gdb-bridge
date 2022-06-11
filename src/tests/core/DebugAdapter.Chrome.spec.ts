import { DebugClient } from "@vscode/debugadapter-testsupport";
import { Server } from "http";
import { createServer } from "http-server";

let dc: DebugClient;
let server: Server;

beforeAll(() => {
    dc = new DebugClient('node', 'dist/vscode/dapServerLauncher.js', 'wasm-chrome', undefined, true);
    server = createServer({ 
        root: "tests/app"
    });
    server.listen(8080);
    return dc.start();
});

afterAll(() => {
    dc.stop();
    server.close();
})

test('should run program on chrome to the end', () => {
    return Promise.all([
        dc.initializeRequest(),
        new Promise<void>(async resolve => {
            await dc.send("launch", { url: "http://localhost:8080/Main.html", type: "wasm-chrome", port: 19101, flags: [ "--headless", "--disable-gpu", "--no-sandbox" ] });
            resolve();
        })
    ]);
}, 20000);

test('should hit breakpoint on chrome', () => {
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
            dc.send("launch", { url: "http://localhost:8080/Main.html", type: "wasm-chrome", port: 19102, flags: [ "--headless", "--disable-gpu" ] });
        })     
    ]);
}, 20000);
