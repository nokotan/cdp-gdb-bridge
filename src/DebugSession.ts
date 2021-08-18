import { WebAssemblyFile } from "./Source"
import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import { DwarfDebugSymbolContainer, read_dwarf } from "../crates/dwarf/pkg"

class DebugSession {

    sources: WebAssemblyFile[];

    constructor() {
        this.sources = [];
    }

    reset() {
        for (const item of this.sources) {
            item.free();
        }

        this.sources = [];
    }

    loadedWebAssembly(wasm: WebAssemblyFile) {
        this.sources.push(wasm);
    }

    findFileFromLocation(loc: Protocol.Debugger.Location) {
        return  this.sources.filter(
                    x => x.scriptID == loc.scriptId
                )[0]?.findFileFromLocation(loc);
    }

    findAddressFromFileLocation(file: string, lineNumber: number) {
        for (const x of this.sources) {
            const address = x.findAddressFromFileLocation(file, lineNumber);

            if (address) {
                return {
                    scriptId: x.scriptID,
                    lineNumber: 0,
                    columnNumber: address.address()
                };
            }
        }

        return undefined;
    }
}

interface DebuggerWorkflowCommand {
    stepOver(): Promise<void>;
    stepIn(): Promise<void>;
    stepOut(): Promise<void>;
    continue(): Promise<void>;
}

interface DebuggerOtherCommand {
    setBreakPoint(location: string): Promise<string>;
    removeBreakPoint(id: string): Promise<void>;
}

export type DebuggerCommand = DebuggerWorkflowCommand & DebuggerOtherCommand;

class NormalSessionState implements DebuggerWorkflowCommand {
    async stepOver() {
        console.warn('Debugger not paused!');
    }
    async stepIn() {
        console.warn('Debugger not paused!');
    }
    async stepOut() {
        console.warn('Debugger not paused!');
    }
    async continue() {
        console.warn('Debugger not paused!');
    }
}

class PausedSessionState implements DebuggerWorkflowCommand {
    debugger: ProtocolApi.DebuggerApi;

    constructor(_debugger: ProtocolApi.DebuggerApi) {
        this.debugger = _debugger;
    }

    async stepOver() {
        await this.debugger.stepOver({});
    }

    async stepIn() {
        await this.debugger.stepOver({});
    }

    async stepOut() {
        await this.debugger.stepOut();
    }

    async continue() {
        await this.debugger.resume({});
    }
}

export class DebugSessionManager implements DebuggerCommand {

    private session: DebugSession;
    private debugger: ProtocolApi.DebuggerApi;
    private page: ProtocolApi.PageApi;

    private sessionState: DebuggerWorkflowCommand;

    constructor(_debugger: ProtocolApi.DebuggerApi, _page: ProtocolApi.PageApi) {
        this.session = new DebugSession();
        this.debugger = _debugger;
        this.page = _page;
        this.sessionState = new NormalSessionState();

        this.debugger.on('scriptParsed', (e) => this.onScriptLoaded(e));
        this.debugger.on('paused', (e) => this.onPauesd(e));
        this.debugger.on('resumed', () => this.onResumed());
        this.page.on('loadEventFired', (e) => this.onLoad(e));
    }

    async stepOver() {
        await this.sessionState.stepOver();
    }

    async stepIn() {
        await this.sessionState.stepOver();
    }

    async stepOut() {
        await this.sessionState.stepOut();
    }

    async continue() {
        await this.sessionState.continue();
    }

    async setBreakPoint(location: string) {
        const fileInfo = location.split(':');
        
        if (fileInfo.length < 2)
        {
            return '';
        }

        const debugfilename = fileInfo[0];
        const debuglinenumber = Number(fileInfo[1]);

        const wasmLocation = this.session.findAddressFromFileLocation(debugfilename, debuglinenumber);
        const bpID = await this.debugger.setBreakpoint({ location: wasmLocation! });

        console.log(`Set Breakpoint: ${bpID.breakpointId}`)

        return bpID.breakpointId;
    }

    async removeBreakPoint(id: string) {
        await this.debugger.removeBreakpoint({
            breakpointId: id
        })
    }

    private async onScriptLoaded(e: Protocol.Debugger.ScriptParsedEvent) {
        console.log(e.url);

        if (e.scriptLanguage == "WebAssembly") {
            console.log(`Start Loading ${e.url}...`);

            const response = await this.debugger.getScriptSource({ scriptId: e.scriptId });
            const buffer = Buffer.from(response?.bytecode!, 'base64');

            const container = read_dwarf(new Uint8Array(buffer));
            this.session.loadedWebAssembly(new WebAssemblyFile(e.scriptId, container));

            console.log(`Found Source: ${container.size()} files`);
        }
    }

    private async onPauesd(e: Protocol.Debugger.PausedEvent) {
        console.log("Hit breakpoint");
        const pausedLocation = e.callFrames[0].location;

        const loc = this.session.findFileFromLocation(pausedLocation);

        if (loc) {
            console.log(`paused at ${loc.file()}:${loc.line()}`)
        } else {
            console.log(`paused at <${e.callFrames[0].url}+${pausedLocation.columnNumber!}>`)
        }

        this.sessionState = new PausedSessionState(this.debugger);
    }

    private async onResumed() {
        this.sessionState = new NormalSessionState();
    }

    private async onLoad(e: Protocol.Page.DomContentEventFiredEvent) {
        console.log('Page navigated.');
        // this.session.reset();
    }
}