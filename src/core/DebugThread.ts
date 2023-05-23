import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import {
	StoppedEvent, BreakpointEvent, ContinuedEvent
} from '@vscode/debugadapter';
import { WebAssemblyFile } from "./WebAssembly/File"
import { DwarfDebugSymbolContainer, WasmLineInfo } from "../../crates/dwarf/pkg";
import { DebugAdapter } from './DebugAdapterInterface';
import { DebuggerWorkflowCommand, DebuggerDumpCommand, DebuggerCommand, WebAssemblyDebugState, RuntimeBreakPoint, IBreakPoint, FileLocation, RuntimeStackFrame, ThreadDebuggerCommand } from './DebugCommand';
import { RunningDebugSessionState } from './DebugSessionState/RunningDebugSessionState';
import { PausedDebugSessionState } from './DebugSessionState/PausedDebugSessionState';
import { WebAssemblyFileRegistory } from "./WebAssembly/FileRegistory";
import CDP from 'chrome-remote-interface';

export class Thread implements ThreadDebuggerCommand {
    private session: WebAssemblyFileRegistory;
    
    private debugger?: ProtocolApi.DebuggerApi;
    private runtime?: ProtocolApi.RuntimeApi;
    private debugAdapter: DebugAdapter;

    private breakPoints: RuntimeBreakPoint[] = [];

    private readonly threadID: number;

    private sessionState: DebuggerWorkflowCommand & DebuggerDumpCommand;
    private scriptParsed?: Promise<void>;

    private steppingOver = false;
    private steppingIn = false;

    constructor(_debugAdapter: DebugAdapter, threadID: number, fileRegistory: WebAssemblyFileRegistory) {
        this.debugAdapter = _debugAdapter;
      
        this.sessionState = new RunningDebugSessionState();
        this.threadID = threadID;
        this.session = fileRegistory;
    }

    setChromeDebuggerApi(_debugger: ProtocolApi.DebuggerApi, _runtime: ProtocolApi.RuntimeApi) {
        this.debugger = _debugger;
        this.runtime = _runtime;

        this.debugger.on('scriptParsed', (e) => this.onScriptLoaded(e));
        this.debugger.on('paused', (e) => void this.onPaused(e));
        this.debugger.on('resumed', () => void this.onResumed());

        this.runtime.runIfWaitingForDebugger();
    }

    async stepOver() {
        this.steppingOver = true;
        await this.sessionState.stepOver();
    }

    async stepIn() {
        this.steppingIn = true;
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

        const bpInfo = {
            id: bpID,
            file: debugfilename,
            line: debugline,
            verified: false
        };

        this.breakPoints.push(bpInfo);

        await this.updateBreakPoint();

        return bpInfo;
    }

    async updateBreakPoint() {
        const promises = this.breakPoints.filter(x => !x.verified).map(async bpInfo => {
            if (!this.session) {
                return bpInfo;
            }

            const wasmLocation = this.session.findAddressFromFileLocation(bpInfo.file, bpInfo.line);
    
            if (!wasmLocation) {
                console.error("cannot find address of specified file");
                return bpInfo;
            }
    
            const wasmDebuggerLocation = { 
                url: wasmLocation.url,  
                scriptId: wasmLocation.scriptId,
                lineNumber: wasmLocation.line,
                columnNumber: wasmLocation.column
            };
    
            console.error(`update breakpoint ${bpInfo.file}:${bpInfo.line} -> ${wasmLocation.column}`);

            const bp = await this.debugger!.setBreakpointByUrl(wasmDebuggerLocation)
                .catch(e => {
                    console.error(e);
                    return null;
                });

            if (bp) {
                const correspondingLocation = this.session.findFileFromLocation(wasmDebuggerLocation)!;

                bpInfo.file = correspondingLocation.file();
                bpInfo.line = correspondingLocation.line!;
                bpInfo.rawId = bp.breakpointId;
                bpInfo.verified = true;
            }

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

    private onScriptLoaded(e: Protocol.Debugger.ScriptParsedEvent) {
        console.error(`${e.url}`);
        if (e.scriptLanguage == "WebAssembly") {
            console.error(`Start Loading ${e.url}...`);
            
            this.scriptParsed = (async () => {
                const response = await this.debugger!.getScriptSource({ scriptId: e.scriptId });
                const buffer = Buffer.from(response?.bytecode || '', 'base64');

                this.session!.loadWebAssembly(e.url, e.scriptId, buffer);

                console.error(`Finish Loading ${e.url}`);

                await this.updateBreakPoint();
            })();
        }
    }

    private lastPausedLocation?: RuntimeStackFrame;

    private async onPaused(e: Protocol.Debugger.PausedEvent) {
        if (e.reason.startsWith("Break on start")) {
            await this.debugger?.resume({});
            return;
        } else if (e.reason == "instrumentation") {
            console.error("Instrumentation BreakPoint");
            if (this.scriptParsed) {
                console.error("awaiting scriptParsed...");
                await this.scriptParsed;
            }
            await this.debugger?.resume({});
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

        if ((this.steppingOver || this.steppingIn)
            && this.lastPausedLocation?.stack.file == stackFrames[0].stack.file
            && this.lastPausedLocation?.stack.line == stackFrames[0].stack.line) {

            if (this.steppingOver) {
                void this.debugger?.stepOver({});
            } else {
                void this.debugger?.stepInto({});
            }
        } else {
            this.steppingOver = false;
            this.steppingIn = false;
            this.lastPausedLocation = stackFrames[0];

            this.sessionState = new PausedDebugSessionState(this.debugger!, this.runtime!, this.session!, stackFrames);
            this.debugAdapter.sendEvent(new StoppedEvent('BreakPointMapping', this.threadID));
        }
    }

    private onResumed() {
        this.sessionState = new RunningDebugSessionState();
        this.debugAdapter.sendEvent(new ContinuedEvent(this.threadID));
    }
}