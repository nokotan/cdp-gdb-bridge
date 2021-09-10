import { DebuggerWorkflowCommand, DebuggerDumpCommand } from '../DebugCommand';

export class RunningDebugSessionState implements DebuggerWorkflowCommand, DebuggerDumpCommand {
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