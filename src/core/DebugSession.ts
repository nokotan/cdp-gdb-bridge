import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import {
	StoppedEvent, BreakpointEvent
} from 'vscode-debugadapter';
import { WebAssemblyFile } from "./Source"
import { DwarfDebugSymbolContainer } from "../../crates/dwarf/pkg";
import { DebugAdapter } from './DebugAdapterInterface';
import { DebuggerWorkflowCommand, DebuggerDumpCommand, DebuggerCommand, WebAssemblyDebugState, RuntimeBreakPoint, IBreakPoint } from './DebugCommand';
import { RunningDebugSessionState } from './DebugSessionState/RunningDebugSessionState';
import { PausedDebugSessionState } from './DebugSessionState/PausedDebugSessionState';

export class DebugSession {

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

    findAddressFromFileLocation(file: string, line: number) {
        for (const x of this.sources) {
            const address = x.findAddressFromFileLocation(file, line);

            if (address) {
                return {
                    scriptId: x.scriptID,
                    line: 0,
                    column: address
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

    getGlobalVariablelist(inst: number) {
        let list = [];

        for (const x of this.sources) {
            list.push(x.dwarf.global_variable_name_list(inst));
        }

        return list;
    }

    getVariableValue(expr: string, address: number, state: WebAssemblyDebugState) {
        for (const x of this.sources) {
            const info = x.dwarf.get_variable_info(
                expr,
                state.locals,
                state.globals,
                state.stacks,
                address
            );

            if (info) {
                return info;
            }
        }

        return undefined;
    }
}

export class DebugSessionManager implements DebuggerCommand {
    private session: DebugSession;
    private debugger: ProtocolApi.DebuggerApi;
    private page: ProtocolApi.PageApi;
    private runtime: ProtocolApi.RuntimeApi;
    private debugAdapter: DebugAdapter;

    private breakPoints: RuntimeBreakPoint[] = [];

    private readonly DummyThreadID = 1;

    private sessionState: DebuggerWorkflowCommand & DebuggerDumpCommand;

    constructor(_debugger: ProtocolApi.DebuggerApi, _page: ProtocolApi.PageApi, _runtime: ProtocolApi.RuntimeApi, _debugAdapter: DebugAdapter) {
        this.session = new DebugSession();
        this.debugger = _debugger;
        this.page = _page;
        this.runtime = _runtime;
        this.debugAdapter = _debugAdapter;

        this.sessionState = new RunningDebugSessionState();

        this.debugger.on('scriptParsed', (e) => this.onScriptLoaded(e));
        this.debugger.on('paused', (e) => this.onPaused(e));
        this.debugger.on('resumed', () => this.onResumed());
        this.page.on('loadEventFired', (e) => this.onLoad(e));
    }

    async stepOver() {
        await this.sessionState.stepOver();
    }

    async stepIn() {
        await this.sessionState.stepIn();
    }

    async stepOut() {
        await this.sessionState.stepOut();
    }

    async continue() {
        await this.sessionState.continue();
    }

    async getStackFrames() {
        return await this.sessionState.getStackFrames();
    }

    async setFocusedFrame(index: number) {
        this.sessionState.setFocusedFrame(index);
    }

    async showLine() {
        await this.sessionState.showLine();
    }

    async listVariable() {
        return await this.sessionState.listVariable();
    }

    async listGlobalVariable() {
        return await this.sessionState.listGlobalVariable();
    }

    async dumpVariable(expr: string) {
        return await this.sessionState.dumpVariable(expr);
    }

    async setBreakPoint(location: string): Promise<IBreakPoint> {
        const fileInfo = location.split(':');
        
        if (fileInfo.length < 2)
        {
            return { verified: false };
        }

        const debugline = Number(fileInfo.pop());
        const debugfilename = fileInfo.join(":");

        const wasmLocation = this.session.findAddressFromFileLocation(debugfilename, debugline);
        const bpID =
            this.breakPoints.length > 0
            ? Math.max.apply(null, this.breakPoints.map(x => x.id!)) + 1
            : 1;

        if (!wasmLocation) {
            console.log("cannot find address of specified file");

            const bpInfo = {
                id: bpID,
                file: debugfilename,
                line: debugline,
                verified: false
            };

            this.breakPoints.push(bpInfo);
            return bpInfo;
        }

        const wasmDebuggerLocation = { 
            scriptId: wasmLocation.scriptId,  
            lineNumber: wasmLocation.line,
            columnNumber: wasmLocation.column
        };

        const bp = await this.debugger.setBreakpoint({ 
            location: wasmDebuggerLocation
        });

        const correspondingLocation = this.session.findFileFromLocation(wasmDebuggerLocation)!;

        const bpInfo = {
            id: bpID,
            rawId: bp.breakpointId,
            file: correspondingLocation.file(),
            line: correspondingLocation.line!,
            verified: true
        };
        
        this.breakPoints.push(bpInfo);
        return bpInfo;
    }

    async updateBreakPoint() {
        const promises = this.breakPoints.filter(x => !x.verified).map(async bpInfo => {
            const wasmLocation = this.session.findAddressFromFileLocation(bpInfo.file, bpInfo.line);
    
            if (!wasmLocation) {
                console.log("cannot find address of specified file");
                return bpInfo;
            }
    
            const wasmDebuggerLocation = { 
                scriptId: wasmLocation.scriptId,  
                lineNumber: wasmLocation.line,
                columnNumber: wasmLocation.column
            };
    
            const bp = await this.debugger.setBreakpoint({ 
                location: wasmDebuggerLocation
            });
    
            const correspondingLocation = this.session.findFileFromLocation(wasmDebuggerLocation)!;

            bpInfo.file = correspondingLocation.file();
            bpInfo.line = correspondingLocation.line!;
            bpInfo.rawId = bp.breakpointId;
            bpInfo.verified = true;

            return bpInfo;
        });

        const bps = await Promise.all(promises);
        bps.filter(x => x.verified).forEach(x => {
            this.debugAdapter.sendEvent(new BreakpointEvent('changed', x));
        });
    }

    async removeBreakPoint(id: number) {

        const promises = this.breakPoints
            .filter(x => x.id == id)
            .filter(x => !!x.rawId)
            .map(async x => {
                await this.debugger.removeBreakpoint({
                    breakpointId: x.rawId!
                })
            })

        this.breakPoints = this.breakPoints.filter(x => x.id != id);   
        await Promise.all(promises);
    }

    async removeAllBreakPoints(path: string) {
        const promises = this.breakPoints
            .filter(x => x.file == path)
            .filter(x => !!x.rawId)
            .map(async x => {
                await this.debugger.removeBreakpoint({
                    breakpointId: x.rawId!
                })
            });

        this.breakPoints = this.breakPoints.filter(x => x.file != path);  
        await Promise.all(promises);
    }

    async getBreakPointsList(location: string) {
        const fileInfo = location.split(':');
        
        if (fileInfo.length < 2)
        {
            return [];
        }

        const debugfilename = fileInfo[0];
        const debugline = Number(fileInfo[1]);

        return this.breakPoints.filter(x => {
                return x.file == debugfilename && x.line == debugline;
            }).map(x => {
                return {
                    ...x,
                    verified: true
                };
            });
    }

    async jumpToPage(url: string) {
        this.page.navigate({
            url
        });
    }

    private async onScriptLoaded(e: Protocol.Debugger.ScriptParsedEvent) {
        console.log(e.url);

        if (e.scriptLanguage == "WebAssembly") {
            console.log(`Start Loading ${e.url}...`);

            const response = await this.debugger.getScriptSource({ scriptId: e.scriptId });
            const buffer = Buffer.from(response?.bytecode!, 'base64');

            const container = DwarfDebugSymbolContainer.new(new Uint8Array(buffer));
            this.session.loadedWebAssembly(new WebAssemblyFile(e.scriptId, container));

            console.log(`Finish Loading ${e.url}`);

            this.updateBreakPoint();
        }
    }

    private async onPaused(e: Protocol.Debugger.PausedEvent) {
        console.log("Hit BreakPoint");

        const stackFrames = e.callFrames.map((v, i) => {
            const dwarfLocation = this.session.findFileFromLocation(v.location);

            return {
                frame: v,
                stack: {
                    index: i,
                    name: v.functionName,
                    instruction: v.location.columnNumber,
                    file: dwarfLocation?.file() || v.url,
                    line: dwarfLocation?.line || v.location.lineNumber,
                }
            };
        });

        this.sessionState = new PausedDebugSessionState(this.debugger, this.runtime, this.session, stackFrames);

        this.debugAdapter.sendEvent(new StoppedEvent('BreakPointMapping', this.DummyThreadID));
    }

    private async onResumed() {
        this.sessionState = new RunningDebugSessionState();
    }

    private async onLoad(e: Protocol.Page.DomContentEventFiredEvent) {
        console.log('Page navigated.');
        this.breakPoints = [];
        this.session.reset();
    }
}