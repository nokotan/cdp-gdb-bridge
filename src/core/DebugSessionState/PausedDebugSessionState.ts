import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import { existsSync, readFileSync } from "fs"
import { DebuggerWorkflowCommand, DebuggerDumpCommand, RuntimeStackFrame, Variable } from '../DebugCommand';
import { DebugSession } from '../DebugSession';
import { createWasmValueStore } from "../InterOp";

class MemoryEvaluator {
    private debugger: ProtocolApi.DebuggerApi;

    private evaluationCache: Map<number, number[]>;
    private pendingEvaluations: Map<number, Promise<number[]>>;

    constructor(_debugger: ProtocolApi.DebuggerApi) {
        this.debugger = _debugger;

        this.evaluationCache = new Map();
        this.pendingEvaluations = new Map();
    }

    evaluate(callframeId: Protocol.Debugger.CallFrameId, address: number, size: number): Promise<number[]> {
        const cache = this.evaluationCache.get(address);

        if (cache && size <= cache.length) {
            return Promise.resolve(cache.slice(0, size));
        }

        const pending = this.pendingEvaluations.get(address);

        if (pending) {
            return pending;
        }

        const evaluator = (async () => {
            const evalResult = await this.debugger.evaluateOnCallFrame({
                callFrameId: callframeId,
                expression: `new Uint8Array(memories[0].buffer).subarray(${address}, ${address + size})`,
                returnByValue: true
            });
    
            const values = Object.values(evalResult.result.value) as number[];
            this.pendingEvaluations.delete(address);
            this.evaluationCache.set(address, values);

            return values;
        })();

        this.pendingEvaluations.set(address, evaluator);
        return evaluator;
    }
}

export class PausedDebugSessionState implements DebuggerWorkflowCommand, DebuggerDumpCommand {

    private debugger: ProtocolApi.DebuggerApi;
    private runtime: ProtocolApi.RuntimeApi;
    private debugSession: DebugSession;
    private stackFrames: RuntimeStackFrame[];
    private memoryEvaluator: MemoryEvaluator;

    private selectedFrameIndex: number = 0;

    constructor(_debugger: ProtocolApi.DebuggerApi, _runtime: ProtocolApi.RuntimeApi, _debugSession: DebugSession, _stackFrames: RuntimeStackFrame[]) {
        this.debugger = _debugger;
        this.runtime = _runtime;
        this.debugSession = _debugSession;
        this.stackFrames = _stackFrames;
        this.memoryEvaluator = new MemoryEvaluator(_debugger);
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
                console.error((i + 1 == frame.stack.line ? '->' : '  ') + ` ${i + 1}  ${lines[i]}`);
            }
        }
    }

    async listVariable(variableReference?: number) {
        const frame = this.stackFrames[this.selectedFrameIndex];
        const varlist = this.debugSession.getVariablelistFromAddress(frame.stack.instruction!);

        if (!varlist) {
            return [];
        }

        let list: Variable[] = [];

        for (let i = 0; i < varlist.size(); i++)
        {
            const name = varlist.at_name(i);
            const type = varlist.at_type_name(i);
            const groupId = varlist.at_group_id(i);
            const childGroupId = varlist.at_chile_group_id(i);
            
            if (!variableReference)
            {
                list.push({
                    name, type, childGroupId
                })
            }
            else if (variableReference == groupId)
            {
                list.push({
                    name, type, childGroupId
                })
            }
        }

        return list;
    }

    async listGlobalVariable(variableReference?: number) {
        const frame = this.stackFrames[this.selectedFrameIndex];
        const varlists = this.debugSession.getGlobalVariablelist(frame.stack.instruction!);

        if (varlists.length <= 0) {
            return [];
        }

        let list: Variable[] = [];

        for (const varlist of varlists) {
            if (!varlist) {
                continue;
            }
            
            for (let i = 0; i < varlist.size(); i++)
            {
                const name = varlist.at_name(i);
                const type = varlist.at_type_name(i);
                const groupId = varlist.at_group_id(i);
                const childGroupId = varlist.at_chile_group_id(i);
                
                if (!variableReference)
                {
                    list.push({
                        name, type, childGroupId
                    })
                }
                else if (variableReference == groupId)
                {
                    list.push({
                        name, type, childGroupId
                    })
                }
            }
        }

        return list;
    }

    async dumpVariable(expr: string) {
        const frame = this.stackFrames[this.selectedFrameIndex];

        if (!frame.state) {
            if (!frame.statePromise) {
                frame.statePromise = this.createWasmValueStore(frame.frame);
            }
            
            frame.state = await frame.statePromise;
        }

        const wasmVariable = this.debugSession.getVariableValue(expr, frame.stack.instruction!, frame.state);

        if (!wasmVariable) {
            return;
        }
        
        let evaluationResult = wasmVariable.evaluate() || '<failure>';
        let limit = 0;

        while (wasmVariable.is_required_memory_slice() && limit < 20) { 
            const slice = wasmVariable.required_memory_slice();
            const result = await this.memoryEvaluator.evaluate(frame.frame.callFrameId, slice.address, slice.byte_size);
            slice.set_memory_slice(new Uint8Array(result));
            evaluationResult = wasmVariable.resume_with_memory_slice(slice) || evaluationResult;

            limit++;
        }

        return evaluationResult;
    }

    private async createWasmValueStore(frame: Protocol.Debugger.CallFrame) {
        const getStackStore = async () => {
            let wasmStacks = (await this.runtime.getProperties({ 
                objectId: frame.scopeChain.filter(x => x.type == "wasm-expression-stack")[0].object.objectId!,
            })).result;

            // TODO: no longer needed for node v14.x?
            if (wasmStacks.length > 0 && wasmStacks[0].value!.objectId) {
                wasmStacks = (await this.runtime.getProperties({
                    objectId: wasmStacks[0].value!.objectId!,
                })).result;
            }
    
            return await createWasmValueStore(this.runtime, wasmStacks);
        }

        const getLocalsStore = async () => {
            let wasmLocalObject = (await this.runtime.getProperties({ 
                objectId: frame.scopeChain.filter(x => x.type == "local")[0].object.objectId!,
            })).result;

            // TODO: no longer needed for node v14.x?
            if (wasmLocalObject.length > 0 && wasmLocalObject[0].name == 'locals') {
                wasmLocalObject = (await this.runtime.getProperties({ 
                    objectId: wasmLocalObject[0].value!.objectId!,
                })).result;
            }
    
            return await createWasmValueStore(this.runtime, wasmLocalObject);
        }

        const getGlobalsStore = async () => {
            const wasmModuleObject = (await this.runtime.getProperties({ 
                objectId: frame.scopeChain.filter(x => x.type == "module")[0].object.objectId!,
                // ownProperties: true
            })).result;
    
            const wasmGlobalsObject = wasmModuleObject.filter(x => x.name == 'globals')[0];
    
            const wasmGlobals = (await this.runtime.getProperties({
                objectId: wasmGlobalsObject.value!.objectId!,
                // ownProperties: true
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