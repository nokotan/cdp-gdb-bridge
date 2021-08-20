import { WebAssemblyFile } from "./Source"
import { existsSync, readFileSync } from "fs"
import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import { DwarfDebugSymbolContainer, read_dwarf } from "../crates/dwarf/pkg"
import { Session } from "inspector";

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

    getVariablelistFromAddress(address: number) {
        for (const x of this.sources) {
            const list = x.dwarf.variable_name_list(address);

            if (list && list.size() > 0) {
                return list;
            }
        }

        return undefined;
    }
}

interface DebuggerDumpCommand {
    showLine(): Promise<void>;
    listVariable(): Promise<void>;
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

export type DebuggerCommand = DebuggerWorkflowCommand & DebuggerDumpCommand & DebuggerOtherCommand;

interface FileLocation {
    file: string,
    lineNumber: number,
    columnNumber?: number
}

class NormalSessionState implements DebuggerWorkflowCommand, DebuggerDumpCommand {
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
    async showLine() {
        console.warn('Debugger not paused!');
    }
    async listVariable() {
        console.warn('Debugger not paused!');
    }
}

class PausedSessionState implements DebuggerWorkflowCommand, DebuggerDumpCommand {
    debugger: ProtocolApi.DebuggerApi;
    debugSession: DebugSession;
    stackFrame: FileLocation[];
    pausedWasmFile: FileLocation;

    constructor(_debugger: ProtocolApi.DebuggerApi, _debugSession: DebugSession, _stackFrame: FileLocation[], _pausedWasmFile: FileLocation) {
        this.debugger = _debugger;
        this.stackFrame = _stackFrame;
        this.pausedWasmFile = _pausedWasmFile;
        this.debugSession = _debugSession;
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

    async showLine() {  
        if (existsSync(this.stackFrame[0].file)) {
            const lines = readFileSync(this.stackFrame[0].file, { encoding: 'utf8' }).replace(/\t/g, '    ').split('\n');
            const startLine = Math.max(0, this.stackFrame[0].lineNumber - 10);
            const endLine = Math.min(lines.length - 1, this.stackFrame[0].lineNumber + 10);

            for (let i = startLine; i <= endLine; i++) {
                console.log((i + 1 == this.stackFrame[0].lineNumber ? '->' : '  ') + ` ${i + 1}  ${lines[i]}`);
            }
        } else {
            console.log('not available.')
        }
    }

    async listVariable() {
        const varlist = this.debugSession.getVariablelistFromAddress(this.pausedWasmFile.columnNumber!);

        if (!varlist) {
            console.log('not available.');
            return;
        }

        for (let i = 0; i < varlist.size(); i++)
        {
            const name = varlist.at_name(i);
            const typeName = varlist.at_type_name(i);

            console.log(`  ${name}: ${typeName}`);
        }
    }
}

export class DebugSessionManager implements DebuggerCommand {

    private session: DebugSession;
    private debugger: ProtocolApi.DebuggerApi;
    private page: ProtocolApi.PageApi;
    private runtime: ProtocolApi.RuntimeApi;

    private sessionState: DebuggerWorkflowCommand & DebuggerDumpCommand;

    constructor(_debugger: ProtocolApi.DebuggerApi, _page: ProtocolApi.PageApi, _runtime: ProtocolApi.RuntimeApi) {
        this.session = new DebugSession();
        this.debugger = _debugger;
        this.page = _page;
        this.runtime = _runtime;
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

    async showLine() {
        await this.sessionState.showLine();
    }

    async listVariable() {
        await this.sessionState.listVariable();
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
        const dwarfLocation = this.session.findFileFromLocation(pausedLocation);
        let pausedFileLocation: FileLocation;
        let rawPausedFileLocation: FileLocation = { 
            file: e.callFrames[0].url, 
            lineNumber: 0, 
            columnNumber: pausedLocation.columnNumber 
        };

        if (dwarfLocation) {
            pausedFileLocation = { file: dwarfLocation.file(), lineNumber: dwarfLocation.line() };
            console.log(`paused at ${pausedFileLocation.file}:${pausedFileLocation.lineNumber}`)
        } else {
            pausedFileLocation = rawPausedFileLocation;
            console.log(`paused at <${e.callFrames[0].url}+${pausedLocation.columnNumber!}>`)
        }

        this.sessionState = new PausedSessionState(this.debugger, this.session, [ pausedFileLocation ], rawPausedFileLocation);

        // const mayBeObject = await this.runtime.getProperties({objectId: e.callFrames[0].scopeChain[2].object.objectId!})
        // const mayBeMemory = await this.runtime.getProperties({objectId: mayBeObject.result.filter(x => x.name == 'memories')[0].value!.objectId!})
        // const Memory = mayBeMemory.result[0];
        // const MemoryProp = await this.runtime.getProperties({objectId: Memory.value!.objectId!})
        // console.log(MemoryProp);
    }

    private async onResumed() {
        this.sessionState = new NormalSessionState();
    }

    private async onLoad(e: Protocol.Page.DomContentEventFiredEvent) {
        console.log('Page navigated.');
        // this.session.reset();
    }
}