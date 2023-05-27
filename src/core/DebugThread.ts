import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import {
    StoppedEvent, BreakpointEvent, ContinuedEvent
} from '@vscode/debugadapter';
import { DebugAdapter } from './DebugAdapterInterface';
import { DebuggerWorkflowCommand, DebuggerDumpCommand, FileLocation, RuntimeStackFrame, ThreadDebuggerCommand } from './DebugCommand';
import { RunningDebugSessionState } from './DebugSessionState/RunningDebugSessionState';
import { PausedDebugSessionState } from './DebugSessionState/PausedDebugSessionState';
import { WebAssemblyFileRegistory } from "./WebAssembly/FileRegistory";
import { CDPDebugger } from './CDP/CDPDebuggerApi';
import { BreakPointsManager, ResolvedBreakPoint } from './BreakPoint/BreakPointsManager';

interface BreakPointMapping {
    id: number;
    rawId?: string;
    verified: boolean;
}

type MappedBreakPoint = BreakPointMapping & FileLocation;

export class Thread implements ThreadDebuggerCommand {
    private debugger?: ProtocolApi.DebuggerApi & CDPDebugger;
    private runtime?: ProtocolApi.RuntimeApi;
    private debugAdapter: DebugAdapter;

    private fileRegistory: WebAssemblyFileRegistory;
    private breakPointsManager: BreakPointsManager;

    private breakPoints: MappedBreakPoint[] = [];

    private readonly threadID: number;
    private readonly sessionID: string;

    private sessionState: DebuggerWorkflowCommand & DebuggerDumpCommand;
    private scriptParsed?: Promise<void>;

    private steppingOver = false;
    private steppingIn = false;

    constructor(_debugAdapter: DebugAdapter, threadID: number, sessionId: string, bpManager: BreakPointsManager) {
        this.debugAdapter = _debugAdapter;
      
        this.sessionState = new RunningDebugSessionState();
        this.breakPointsManager = bpManager;
        this.threadID = threadID;
        this.sessionID = sessionId;
        this.fileRegistory = new WebAssemblyFileRegistory();
    }

    setChromeDebuggerApi(_debugger: ProtocolApi.DebuggerApi, _runtime: ProtocolApi.RuntimeApi) {
        this.debugger = _debugger as ProtocolApi.DebuggerApi & CDPDebugger;
        this.runtime = _runtime;

        this.debugger.on('scriptParsed', (e, x?: string) => this.onScriptLoaded(e, x));
        this.debugger.on('paused', (e, x?: string) => void this.onPaused(e, x));
        this.debugger.on('resumed', (x?: string) => void this.onResumed(x));
    }

    async activate() {
        await this.debugger?.enable({});
        await this.debugger?.setInstrumentationBreakpoint({ instrumentation: "beforeScriptExecution" });
        await this.runtime?.enable();
        await this.runtime?.runIfWaitingForDebugger();
    }

    async deactivate() {
        await this.debugger?.disable();
        await this.runtime?.disable();
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

    async updateBreakPoint() {
        const currentBreakPoints = this.breakPointsManager.getBreakPoints();

        for (const [ id, bp ] of currentBreakPoints) {
            if (this.breakPoints.filter(x => x.id === id).length === 0) {
                this.breakPoints.push({ ...bp, verified: false });
            }
        }

        const removedBps = this.breakPoints.filter(bp => {
            for (const [ id, _ ] of currentBreakPoints) {
                if (id === bp.id) return false;
            }
            return true;
        });

        const removePromises = removedBps.map(async bp => {
            await this.debugger?.removeBreakpoint({ breakpointId: bp.rawId! });
        });

        await Promise.all(removePromises);

        this.breakPoints = this.breakPoints.filter(bp => 
            !removedBps.find(removed => 
                removed.id === bp.id
            )
        );

        const promises = this.breakPoints.filter(bp => !bp.verified).map(async bp => {
            const wasmLocation = this.fileRegistory.findAddressFromFileLocation(bp.file, bp.line);
    
            if (!wasmLocation) {
                console.error("cannot find address of specified file");
                return bp;
            }
    
            const wasmDebuggerLocation = { 
                url: wasmLocation.url,  
                scriptId: wasmLocation.scriptId,
                lineNumber: wasmLocation.line,
                columnNumber: wasmLocation.column
            };
    
            console.error(`update breakpoint ${bp.file}:${bp.line} -> ${wasmLocation.scriptId}:0:${wasmLocation.column}`);

            const rawBp = await this.debugger?.setBreakpoint({ location: wasmDebuggerLocation })
                .catch(e => {
                    console.error(e);
                    return null;
                });

            if (rawBp) {
                console.error(`breakpoint mapped ${wasmLocation.scriptId}:0:${wasmLocation.column} -> ${rawBp.actualLocation.scriptId}:${rawBp.actualLocation.lineNumber}:${rawBp.actualLocation.columnNumber || 0} (${rawBp.breakpointId})`);

                const correspondingLocation = this.fileRegistory.findFileFromLocation(wasmDebuggerLocation)!;

                bp.file = correspondingLocation.file();
                bp.line = correspondingLocation.line || 0;
                bp.rawId = rawBp.breakpointId;
                bp.verified = true;
            }

            return bp;
        });

        const bps = await Promise.all(promises);
        bps.filter(bp => bp.rawId).forEach(bp => {
            this.debugAdapter.sendEvent(new BreakpointEvent('changed', { ...bp }));
        });
    }

    getBreakPointsList(location: string): Promise<ResolvedBreakPoint[]> {
        const fileInfo = location.split(':');
        
        if (fileInfo.length < 2)
        {
            return Promise.resolve([]);
        }

        const debugfilename = fileInfo[0];
        const debugline = Number(fileInfo[1]);

        return Promise.resolve(this.breakPoints.filter(bp => {
            return bp.file == debugfilename && bp.line == debugline;
        }));
    }

    private onScriptLoaded(e: Protocol.Debugger.ScriptParsedEvent, sessionId?: string) {
        if (sessionId && sessionId != this.sessionID) {
            return;
        }

        if (e.scriptLanguage == "WebAssembly") {
            console.error(`Thread ${this.threadID}: Start Loading ${e.url}...`);
            
            if (this.fileRegistory.sources.has(e.scriptId)) {
                this.scriptParsed = (async () => {
                    await this.updateBreakPoint();
                })();
            } else {
                this.scriptParsed = (async () => {
                    const response = await this.debugger?.getScriptSource({ scriptId: e.scriptId });
                    const buffer = Buffer.from(response?.bytecode || '', 'base64');
    
                    this.fileRegistory?.loadWebAssembly(e.url, e.scriptId, buffer);
    
                    console.error(`Finish Loading ${e.url}`);
    
                    await this.updateBreakPoint();
                })();
            }
        }
    }

    private lastPausedLocation?: RuntimeStackFrame;

    private async onPaused(e: Protocol.Debugger.PausedEvent, sessionId?: string) {
        if (sessionId && sessionId != this.sessionID) {
            return;
        }

        if (e.reason.startsWith("Break on start")) {
            await this.debugger?.resume({});
            return;
        } else if (e.reason == "instrumentation") {
            console.error(`Thread ${this.threadID}: Instrumentation BreakPoint`);
            if (this.scriptParsed) {
                console.error(`Thread ${this.threadID}: awaiting scriptParsed...`);
                await this.scriptParsed;
            }
            await this.debugger?.resume({});
            return;
        }

        console.error(`Thread ${this.threadID}: Hit BreakPoint`);

        const stackFrames = e.callFrames.map((v, i) => {
            const dwarfLocation = this.fileRegistory.findFileFromLocation(v.location);

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

            this.sessionState = new PausedDebugSessionState(this.debugger!, this.runtime!, this.fileRegistory, stackFrames);
            this.debugAdapter.sendEvent(new StoppedEvent('BreakPointMapping', this.threadID));
        }
    }

    private onResumed(sessionId?: string) {
        if (sessionId && sessionId != this.sessionID) {
            return;
        }

        this.sessionState = new RunningDebugSessionState();
        this.debugAdapter.sendEvent(new ContinuedEvent(this.threadID));
    }
}