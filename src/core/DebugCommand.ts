import type Protocol from 'devtools-protocol/types/protocol';
import { WasmValueVector } from "../../crates/dwarf/pkg";
import { ResolvedBreakPoint } from "./BreakPoint/BreakPointsManager";

export interface Variable {
    name: string;
    displayName: string;
    type: string;
    childGroupId?: number;
}

export interface StackFrameFunction {
	index: number;
	name: string;
	instruction?: number;
}

export interface FileLocation {
    file: string,
    line: number,
    column?: number
}

export type IRuntimeStackFrame = StackFrameFunction & FileLocation;

export interface WebAssemblyDebugState {
    stacks: WasmValueVector;
    locals: WasmValueVector;
    globals: WasmValueVector;
}

export interface RuntimeStackFrame {
    frame: Protocol.Debugger.CallFrame;
    stack: IRuntimeStackFrame;
    state?: WebAssemblyDebugState;
    statePromise?: Promise<WebAssemblyDebugState>;
} 

export interface DebuggerDumpCommand {
    showLine(): Promise<void>;
    getStackFrames(): Promise<IRuntimeStackFrame[]>;
    setFocusedFrame(index: number): Promise<void>;
    listVariable(variableReference?: number): Promise<Variable[]>;
    listGlobalVariable(variableReference?: number): Promise<Variable[]>;
    dumpVariable(expr: string): Promise<string | undefined>;
}

export interface DebuggerWorkflowCommand {
    stepOver(): Promise<void>;
    stepIn(): Promise<void>;
    stepOut(): Promise<void>;
    continue(): Promise<void>;
}

export interface DebuggerBreakPointCommand {
    setBreakPoint(location: FileLocation): Promise<ResolvedBreakPoint>;
    removeBreakPoint(id: number): Promise<void>;
    removeAllBreakPoints(path: string): Promise<void>;
    getBreakPointsList(location: string): Promise<ResolvedBreakPoint[]>;
}

export interface DebuggerOtherCommand {
    jumpToPage(url: string): Promise<void>;
}



export type ThreadDebuggerCommand = DebuggerWorkflowCommand & DebuggerDumpCommand;
export type DebuggerCommand = ThreadDebuggerCommand & DebuggerOtherCommand;
