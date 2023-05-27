import { DebugClient } from "@vscode/debugadapter-testsupport";
import createServer, { launchedStatik } from "statikk";

let dc: DebugClient;
let server: launchedStatik;

beforeAll(() => {
    dc = new DebugClient('node', 'dist/vscode/dapServerLauncher.js', 'wasm-chrome', undefined, true);
    server = createServer({ 
        root: "tests/emscripten-pthread-app",
        port: 8081,
        coi: true
    });
    return dc.start();
});

afterAll(() => {
    void dc.stop();
    server.server.close();
})

test('should run program on chrome to the end', async () => {
    await dc.launch({ url: "http://localhost:8081/Main.html", type: "wasm-chrome", port: 19301, flags: [ "--headless", "--disable-gpu", "--no-sandbox" ] });
    await new Promise(resolve => setTimeout(resolve, 2000));
    await Promise.all([           
        dc.waitForEvent("terminated"),
        dc.terminateRequest({})
    ]);
}, 20000);

test('should capture log on chrome', async () => {
    await dc.launch({ url: "http://localhost:8081/Main.html", type: "wasm-chrome", port: 19301, flags: [ "--headless", "--disable-gpu", "--no-sandbox" ] });
    await dc.assertOutput("stdout", "Hei\n");
    await Promise.all([           
        dc.waitForEvent("terminated"),
        dc.terminateRequest({})
    ]);
}, 20000);

test('should hit breakpoint on chrome', async () => {
    const breakPoint = {
        path: "c:/emscripten-simple-app/Main.cpp",
        line: 4
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
        dc.send("launch", { url: "http://localhost:8081/Main.html", type: "wasm-chrome", port: 19302, flags: [ "--headless", "--disable-gpu", "--no-sandbox" ] })
    ]);
    await Promise.all([           
        dc.waitForEvent("terminated"),
        dc.terminateRequest({})
    ]);
}, 20000);

test('should step line by line on chrome', async () => {
    const breakPoint = {
        path: "c:/emscripten-simple-app/Main.cpp",
        line: 4
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
        dc.send("launch", { url: "http://localhost:8081/Main.html", type: "wasm-chrome", port: 19303, flags: [ "--headless", "--disable-gpu", "--no-sandbox" ] })
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
