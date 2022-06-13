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

test('should run program on chrome to the end', async () => {
    await dc.launch({ url: "http://localhost:8080/Main.html", type: "wasm-chrome", port: 19101, flags: [ "--headless", "--disable-gpu", "--no-sandbox" ] });
    await new Promise(resolve => setTimeout(resolve, 2000));
    await Promise.all([           
        dc.waitForEvent("terminated"),
        dc.terminateRequest({})
    ]);
}, 20000);

test('should hit breakpoint on chrome', async () => {
    const breakPoint = {
        path: "/Volumes/SHARED/Visual Studio 2017/EmscriptenTest/Main.cpp",
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
        dc.send("launch", { url: "http://localhost:8080/Main.html", type: "wasm-chrome", port: 19102, flags: [ "--headless", "--disable-gpu", "--no-sandbox" ] })
    ]);
    await Promise.all([           
        dc.waitForEvent("terminated"),
        dc.terminateRequest({})
    ]);
}, 20000);

test('should step line by line on chrome', async () => {
    const breakPoint = {
        path: "/Volumes/SHARED/Visual Studio 2017/EmscriptenTest/Main.cpp",
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
        dc.send("launch", { url: "http://localhost:8080/Main.html", type: "wasm-chrome", port: 19103, flags: [ "--headless", "--disable-gpu", "--no-sandbox" ] })
    ]);
    await Promise.all([           
        dc.assertStoppedLocation("BreakPointMapping", {
            path: breakPoint.path,
            line: breakPoint.line + 1
        }),
        dc.nextRequest({ threadId: 1 })
    ]);
    await Promise.all([           
        dc.waitForEvent("terminated"),
        dc.terminateRequest({})
    ]);
}, 20000);
