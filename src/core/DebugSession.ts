import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import {
	StoppedEvent, InitializedEvent,
} from 'vscode-debugadapter';
import { WebAssemblyFile } from "./Source"
import { WasmValueVector, DwarfDebugSymbolContainer } from "../../crates/dwarf/pkg";
import { createWasmValueStore } from './InterOp'
import { DebugAdapter } from './DebugAdapterInterface';
import { existsSync, readFileSync } from "fs"


export interface Variable {
    name: string;
    type: string;
}

export interface IBreakPoint {
    id?: number;
    line?: number;
    column?: number;
    verified: boolean;
}

interface BreakPointMapping {
    id: number;
    rawId: string;
}

type RuntimeBreakPoint = BreakPointMapping & FileLocation;

interface StackFrameFunction {
	index: number;
	name: string;
	instruction?: number;
}

export interface FileLocation {
    file: string,
    line: number,
    column?: number
}

type IRuntimeStackFrame = StackFrameFunction & FileLocation;

interface WebAssemblyDebugState {
    stacks: WasmValueVector;
    locals: WasmValueVector;
    globals: WasmValueVector;
}

interface RuntimeStackFrame {
    frame: Protocol.Debugger.CallFrame;
    stack: IRuntimeStackFrame;
    state?: WebAssemblyDebugState;
} 

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

interface DebuggerDumpCommand {
    showLine(): Promise<void>;
    getStackFrames(): Promise<IRuntimeStackFrame[]>;
    setFocusedFrame(index: number): Promise<void>;
    listVariable(): Promise<Variable[]>;
    listGlobalVariable(): Promise<Variable[]>;
    dumpVariable(expr: string): Promise<string | undefined>;
}

interface DebuggerWorkflowCommand {
    stepOver(): Promise<void>;
    stepIn(): Promise<void>;
    stepOut(): Promise<void>;
    continue(): Promise<void>;
}

interface DebuggerOtherCommand {
    setBreakPoint(location: string): Promise<IBreakPoint>;
    removeBreakPoint(id: number): Promise<void>;
    removeAllBreakPoints(path: string): Promise<void>;
    getBreakPointsList(location: string): Promise<IBreakPoint[]>;
    jumpToPage(url: string): Promise<void>;
}

export type DebuggerCommand = DebuggerWorkflowCommand & DebuggerDumpCommand & DebuggerOtherCommand;

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
    async getStackFrames() {
        console.warn('Debugger not paused!');
        return [];
    }
    async showLine() {
        console.warn('Debugger not paused!');
    }
    async listVariable() {
        console.warn('Debugger not paused!');
        return [];
    }
    async listGlobalVariable() {
        console.warn('Debugger not paused!');
        return [];
    }
    async dumpVariable() {
        console.warn('Debugger not paused!');
        return undefined;
    }
    async setFocusedFrame() {
        console.warn('Debugger not paused!');
    }
}

class PausedSessionState implements DebuggerWorkflowCommand, DebuggerDumpCommand {

    private debugger: ProtocolApi.DebuggerApi;
    private runtime: ProtocolApi.RuntimeApi;
    private debugSession: DebugSession;
    private stackFrames: RuntimeStackFrame[];
    private selectedFrameIndex: number = 0;

    constructor(_debugger: ProtocolApi.DebuggerApi, _runtime: ProtocolApi.RuntimeApi, _debugSession: DebugSession, _stackFrames: RuntimeStackFrame[]) {
        this.debugger = _debugger;
        this.runtime = _runtime;
        this.debugSession = _debugSession;
        this.stackFrames = _stackFrames;
    }

    async stepOver() {
        await this.debugger.stepOver({});
    }

    async stepIn() {
        await this.debugger.stepInto({});
    }

    async stepOut() {
        await this.debugger.stepOut();
    }

    async continue() {
        await this.debugger.resume({});
    }

    async getStackFrames() {
        return this.stackFrames.map(x => x.stack);
    }

    async setFocusedFrame(index: number) {
        this.selectedFrameIndex = index;
    }

    async showLine() {  
        const frame = this.stackFrames[this.selectedFrameIndex];

        if (existsSync(frame.stack.file)) {
            const lines = readFileSync(frame.stack.file, { encoding: 'utf8' }).replace(/\t/g, '    ').split('\n');
            const startLine = Math.max(0, frame.stack.line - 10);
            const endLine = Math.min(lines.length - 1, frame.stack.line + 10);

            for (let i = startLine; i <= endLine; i++) {
                console.log((i + 1 == frame.stack.line ? '->' : '  ') + ` ${i + 1}  ${lines[i]}`);
            }
        } else {
            console.log('not available.')
        }
    }

    async listVariable() {
        const frame = this.stackFrames[this.selectedFrameIndex];
        const varlist = this.debugSession.getVariablelistFromAddress(frame.stack.instruction!);

        if (!varlist) {
            console.log('not available.');
            return [];
        }

        let list: Variable[] = [];

        for (let i = 0; i < varlist.size(); i++)
        {
            const name = varlist.at_name(i);
            const type = varlist.at_type_name(i);

            list.push({
                name, type
            })
        }

        return list;
    }

    async listGlobalVariable() {
        const frame = this.stackFrames[this.selectedFrameIndex];
        const varlists = this.debugSession.getGlobalVariablelist(frame.stack.instruction!);

        if (varlists.length <= 0) {
            console.log('not available.');
            return [];
        }

        let list: Variable[] = [];

        for (const varlist of varlists) {
            if (!varlist) {
                continue
            }
            
            for (let i = 0; i < varlist.size(); i++)
            {
                const name = varlist.at_name(i);
                const type = varlist.at_type_name(i);

                list.push({
                    name, type
                })
            }
        }

        return list;
    }

    async dumpVariable(expr: string) {
        const frame = this.stackFrames[this.selectedFrameIndex];

        if (!frame.state) {
            frame.state = await this.createWasmValueStore(frame.frame);
        }

        const wasmVariable = this.debugSession.getVariableValue(expr, frame.stack.instruction!, frame.state);

        if (!wasmVariable) {
            console.log('not available.');
            return;
        }

        let evaluationResult = wasmVariable.evaluate() || '<failure>';

        while (wasmVariable.is_required_memory_slice()) { 
            const slice = wasmVariable.required_memory_slice();
            const result = await this.evaluateMemory(slice.address, slice.byte_size);
            slice.set_memory_slice(new Uint8Array(result));
            evaluationResult = wasmVariable.resume_with_memory_slice(slice) || evaluationResult;
        }

        return evaluationResult;
    }

    private async evaluateMemory(address: number, size: number) {
        const evalResult = await this.debugger.evaluateOnCallFrame({
            callFrameId: this.stackFrames[0].frame.callFrameId,
            expression: `new Uint8Array(memories[0].buffer).subarray(${address}, ${address + size})`,
            returnByValue: true
        });

        return Object.values(evalResult.result.value) as number[];
    }

    private async createWasmValueStore(frame: Protocol.Debugger.CallFrame) {
        const getStackStore = async () => {
            const wasmStackObject = (await this.runtime.getProperties({ 
                objectId: frame.scopeChain[0].object.objectId!,
                ownProperties: true
            })).result;
    
            const wasmStacks = (await this.runtime.getProperties({
                objectId: wasmStackObject[0].value!.objectId!,
                ownProperties: true
            })).result;
    
            return await createWasmValueStore(this.runtime, wasmStacks);
        }

        const getLocalsStore = async () => {
            const wasmLocalObject = (await this.runtime.getProperties({ 
                objectId: frame.scopeChain[1].object.objectId!,
                ownProperties: true
            })).result;
    
            return await createWasmValueStore(this.runtime, wasmLocalObject);
        }

        const getGlobalsStore = async () => {
            const wasmModuleObject = (await this.runtime.getProperties({ 
                objectId: frame.scopeChain[2].object.objectId!,
                ownProperties: true
            })).result;
    
            const wasmGlobalsObject = wasmModuleObject.filter(x => x.name == 'globals')[0];
    
            const wasmGlobals = (await this.runtime.getProperties({
                objectId: wasmGlobalsObject.value!.objectId!,
                ownProperties: true
            })).result;
    
            return await createWasmValueStore(this.runtime, wasmGlobals);
        }

        const [ StacksStore, LocalsStore, GlobalsStore] 
            = await Promise.all([ getStackStore(), getLocalsStore(), getGlobalsStore() ]);

        return {
            stacks: StacksStore,
            globals: GlobalsStore,
            locals: LocalsStore
        }
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

        this.sessionState = new NormalSessionState();

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

    async setBreakPoint(location: string) {
        const fileInfo = location.split(':');
        
        if (fileInfo.length < 2)
        {
            return { verified: false };
        }

        const debugline = Number(fileInfo.pop());
        const debugfilename = fileInfo.join(":");

        const wasmLocation = this.session.findAddressFromFileLocation(debugfilename, debugline);
        const bp = await this.debugger.setBreakpoint({ 
            location: { 
                scriptId: wasmLocation?.scriptId!,  
                lineNumber: wasmLocation?.line!,
                columnNumber: wasmLocation?.column
            } 
        });

        const bpID =
            this.breakPoints.length > 0
            ? Math.max.apply(null, this.breakPoints.map(x => x.id)) + 1
            : 1;
        
        this.breakPoints.push({
            id: bpID,
            rawId: bp.breakpointId,
            file: debugfilename,
            line: debugline
        })

        return { id: bpID, line: debugline, verified: true };
    }

    async removeBreakPoint(id: number) {

        const promises = this.breakPoints.filter(x => x.id == id).map(async x => {
            await this.debugger.removeBreakpoint({
                breakpointId: x.rawId
            })
        })

        this.breakPoints = this.breakPoints.filter(x => x.id != id);   
        await Promise.all(promises);
    }

    async removeAllBreakPoints(path: string) {
        const promises = this.breakPoints.filter(x => x.file == path).map(async x => {
            await this.debugger.removeBreakpoint({
                breakpointId: x.rawId
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
            this.debugAdapter.sendEvent(new InitializedEvent());
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

        this.sessionState = new PausedSessionState(this.debugger, this.runtime, this.session, stackFrames);

        this.debugAdapter.sendEvent(new StoppedEvent('BreakPointMapping', this.DummyThreadID));
    }

    private async onResumed() {
        this.sessionState = new NormalSessionState();
    }

    private async onLoad(e: Protocol.Page.DomContentEventFiredEvent) {
        console.log('Page navigated.');
        this.session.reset();
    }
}