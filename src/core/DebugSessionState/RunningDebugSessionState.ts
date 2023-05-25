import { DebuggerWorkflowCommand, DebuggerDumpCommand } from '../DebugCommand';

export class RunningDebugSessionState implements DebuggerWorkflowCommand, DebuggerDumpCommand {
    stepOver() {
        console.warn('Debugger not paused!');
        return Promise.resolve();
    }
    stepIn() {
        console.warn('Debugger not paused!');
        return Promise.resolve();
    }
    stepOut() {
        console.warn('Debugger not paused!');
        return Promise.resolve();
    }
    continue() {
        console.warn('Debugger not paused!');
        return Promise.resolve();
    }
    getStackFrames() {
        console.warn('Debugger not paused!');
        return Promise.resolve([]);
    }
    showLine() {
        console.warn('Debugger not paused!');
        return Promise.resolve();
    }
    listVariable() {
        console.warn('Debugger not paused!');
        return Promise.resolve([]);
    }
    listGlobalVariable() {
        console.warn('Debugger not paused!');
        return Promise.resolve([]);
    }
    dumpVariable() {
        console.warn('Debugger not paused!');
        return Promise.resolve(undefined);
    }
    setFocusedFrame() {
        console.warn('Debugger not paused!');
        return Promise.resolve();
    }
}