import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import {
	StoppedEvent, BreakpointEvent, ContinuedEvent
} from 'vscode-debugadapter';
import { WebAssemblyFile } from "./Source"
import { DwarfDebugSymbolContainer } from "../../crates/dwarf/pkg";
import { DebugAdapter } from './DebugAdapterInterface';
import { DebuggerWorkflowCommand, DebuggerDumpCommand, DebuggerCommand, WebAssemblyDebugState, RuntimeBreakPoint, IBreakPoint, FileLocation } from './DebugCommand';
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
        const list = [];

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
    private session?: DebugSession;
    private debugger?: ProtocolApi.DebuggerApi;
    private page?: ProtocolApi.PageApi;
    private runtime?: ProtocolApi.RuntimeApi;
    private debugAdapter: DebugAdapter;

    private breakPoints: RuntimeBreakPoint[] = [];

    private readonly DummyThreadID = 1;

    private sessionState: DebuggerWorkflowCommand & DebuggerDumpCommand;

    constructor(_debugAdapter: DebugAdapter) {
        this.debugAdapter = _debugAdapter;
      
        this.sessionState = new RunningDebugSessionState();
    }

    async setChromeDebuggerApi(_debugger: ProtocolApi.DebuggerApi, _page: ProtocolApi.PageApi, _runtime: ProtocolApi.RuntimeApi) {
        this.debugger = _debugger;
        this.page = _page;
        this.runtime = _runtime;

        this.debugger.on('scriptParsed', (e) => void this.onScriptLoaded(e));
        this.debugger.on('paused', (e) => void this.onPaused(e));
        this.debugger.on('resumed', () => void this.onResumed());
        if (this.page) this.page.on('loadEventFired', (e) => void this.onLoad(e));

        this.session = new DebugSession();
        
        await this.debugger.setInstrumentationBreakpoint({ instrumentation: "beforeScriptExecution" });
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
        await this.sessionState.setFocusedFrame(index);
    }

    async showLine() {
        await this.sessionState.showLine();
    }

    async listVariable(variableReference?: number) {
        return await this.sessionState.listVariable(variableReference);
    }

    async listGlobalVariable(variableReference?: number) {
        return await this.sessionState.listGlobalVariable(variableReference);
    }

    async dumpVariable(expr: string) {
        return await this.sessionState.dumpVariable(expr);
    }

    async setBreakPoint(location: FileLocation): Promise<IBreakPoint> {
        const debugline = location.line;
        const debugfilename = location.file;
        const bpID =
            this.breakPoints.length > 0
            ? Math.max.apply(null, this.breakPoints.map(x => x.id!)) + 1
            : 1;

        if (!this.session)
        {
            const bpInfo = {
                id: bpID,
                file: debugfilename,
                line: debugline,
                verified: false
            };

            this.breakPoints.push(bpInfo);
            return bpInfo;
        }

        const wasmLocation = this.session.findAddressFromFileLocation(debugfilename, debugline);
       
        if (!wasmLocation) {
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

        const bp = await this.debugger!.setBreakpoint({ 
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
            const wasmLocation = this.session!.findAddressFromFileLocation(bpInfo.file, bpInfo.line);
    
            if (!wasmLocation) {
                console.error("cannot find address of specified file");
                return bpInfo;
            }
    
            const wasmDebuggerLocation = { 
                scriptId: wasmLocation.scriptId,  
                lineNumber: wasmLocation.line,
                columnNumber: wasmLocation.column
            };
    
            const bp = await this.debugger!.setBreakpoint({ 
                location: wasmDebuggerLocation
            });
    
            const correspondingLocation = this.session!.findFileFromLocation(wasmDebuggerLocation)!;

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
                await this.debugger?.removeBreakpoint({
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
                await this.debugger?.removeBreakpoint({
                    breakpointId: x.rawId!
                })
            });

        this.breakPoints = this.breakPoints.filter(x => x.file != path);  
        await Promise.all(promises);
    }

    getBreakPointsList(location: string): Promise<IBreakPoint[]> {
        const fileInfo = location.split(':');
        
        if (fileInfo.length < 2)
        {
            return Promise.resolve([]);
        }

        const debugfilename = fileInfo[0];
        const debugline = Number(fileInfo[1]);

        return Promise.resolve(this.breakPoints.filter(x => {
                return x.file == debugfilename && x.line == debugline;
            }).map(x => {
                return {
                    ...x,
                    verified: true
                };
            }));
    }

    async jumpToPage(url: string) {
        await this.page?.navigate({
            url
        });
    }

    private async onScriptLoaded(e: Protocol.Debugger.ScriptParsedEvent) {
        if (e.scriptLanguage == "WebAssembly") {
            console.error(`Start Loading ${e.url}...`);

            const response = await this.debugger!.getScriptSource({ scriptId: e.scriptId });
            const buffer = Buffer.from(response?.bytecode || '', 'base64');

            const container = DwarfDebugSymbolContainer.new(new Uint8Array(buffer));
            this.session!.loadedWebAssembly(new WebAssemblyFile(e.scriptId, container));

            console.error(`Finish Loading ${e.url}`);

            await this.updateBreakPoint();
        }

        this.debugger?.resume({});
    }

    private onPaused(e: Protocol.Debugger.PausedEvent) {
        if (e.reason == "instrumentation") {
            console.error("Instrumentation BreakPoint");
            return;
        }

        console.error("Hit BreakPoint");

        const stackFrames = e.callFrames.map((v, i) => {
            const dwarfLocation = this.session!.findFileFromLocation(v.location);

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

        this.sessionState = new PausedDebugSessionState(this.debugger!, this.runtime!, this.session!, stackFrames);
        this.debugAdapter.sendEvent(new StoppedEvent('BreakPointMapping', this.DummyThreadID));
    }

    private onResumed() {
        this.sessionState = new RunningDebugSessionState();
        this.debugAdapter.sendEvent(new ContinuedEvent(this.DummyThreadID));
    }

    private onLoad(e: Protocol.Page.DomContentEventFiredEvent) {
        console.error('Page navigated.');
        this.breakPoints.forEach(x => x.verified = false);
        this.session!.reset();
    }
}