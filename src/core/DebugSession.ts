import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import { DebugAdapter } from './DebugAdapterInterface';
import { IBreakPoint, FileLocation } from './DebugCommand';
import { WebAssemblyFileRegistory } from "./WebAssembly/FileRegistory";
import { Thread } from './DebugThread';
import { createDebuggerProxy, createRuntimeProxy } from './CDP/CDPProxy';
import { ThreadEvent } from '@vscode/debugadapter';

export interface ThreadInfo {
    threadID: number;
    threadName: string;
}

export class DebugSession {
    private fileRegistory: WebAssemblyFileRegistory;
    private threads: Map<number, Thread>;
    private sessionToThreadInfo: Map<string, ThreadInfo>;

    private debugger?: ProtocolApi.DebuggerApi;
    private page?: ProtocolApi.PageApi;
    private runtime?: ProtocolApi.RuntimeApi;
    private target?: ProtocolApi.TargetApi;

    private defaultThread?: Thread;

    private debugAdapter: DebugAdapter;
    private lastThreadId: number = 1;
    private focusedThreadId: number = 0;

    private requestedBpLists: Map<string, FileLocation[]>;

    constructor(_debugAdapter: DebugAdapter) {
        this.debugAdapter = _debugAdapter;
        this.fileRegistory = new WebAssemblyFileRegistory();
        this.threads = new Map();
        this.sessionToThreadInfo = new Map();
        this.requestedBpLists = new Map();
    }

    setChromeDebuggerApi(_debugger: ProtocolApi.DebuggerApi, _page: ProtocolApi.PageApi, _runtime: ProtocolApi.RuntimeApi, _target?: ProtocolApi.TargetApi) {
        this.debugger = _debugger;
        this.page = _page;
        this.runtime = _runtime;
        this.target = _target;

        this.page?.on("loadEventFired", (e) => void this.onLoad(e));
        this.target?.on("attachedToTarget", (e) => void this.onThreadCreated(e));
        this.target?.on("detachedFromTarget", (e) => void this.onThreadDestroyed(e));
        
        this.target?.setDiscoverTargets({ discover: true });
        this.target?.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

        this.defaultThread = new Thread(this.debugAdapter, 0, "", this.fileRegistory);
        this.defaultThread.setChromeDebuggerApi(this.debugger, this.runtime);

        this.reset();
    }

    private reset() {
        this.threads.clear();
        this.sessionToThreadInfo.clear();
        this.requestedBpLists.clear();
        this.lastThreadId = 1;

        this.threads.set(0, this.defaultThread!);
        this.sessionToThreadInfo.set("default", { threadID: 0, threadName: "default thread" });
    }

    async stepOver(threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        await thread?.stepOver();
    }

    async stepIn(threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        await thread?.stepIn();
    }

    async stepOut(threadId?: number) {   
        const thread = this.threads.get(threadId || this.focusedThreadId);
        await thread?.stepOut();
    }

    async continue(threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        await thread?.continue();
    }

    async getStackFrames(threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        return (await thread?.getStackFrames()) || [];
    }

    async setFocusedThread(threadId: number) {
        this.focusedThreadId = threadId;
    }

    async setFocusedFrame(index: number, threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        return await thread?.setFocusedFrame(index);
    }

    async showLine(threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        return await thread?.showLine();
    }

    async listVariable(variableReference?: number, threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        return await thread!.listVariable(variableReference);
    }

    async listGlobalVariable(variableReference?: number, threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        return await thread!.listGlobalVariable(variableReference);
    }

    async dumpVariable(expr: string, threadId?: number) {
        const thread = this.threads.get(threadId || this.focusedThreadId);
        return await thread?.dumpVariable(expr);
    }

    async setBreakPoint(location: FileLocation): Promise<IBreakPoint> {
        const breakPoints = [];

        if (!this.requestedBpLists.has(location.file)) {
            this.requestedBpLists.set(location.file, [ location ]);
        } else {
            this.requestedBpLists.get(location.file)?.push(location);
        }

        for (const thread of this.threads.values()) {
            const breakPoint = await thread.setBreakPoint(location);
            breakPoints.push(breakPoint);
        }

        return breakPoints[0];
    }

    async removeBreakPoint(id: number) {
        for (const thread of this.threads.values()) {
            await thread.removeBreakPoint(id);
        }
    }

    async removeAllBreakPoints(path: string) {
        this.requestedBpLists.get(path)?.splice(0);

        for (const thread of this.threads.values()) {
            await thread.removeAllBreakPoints(path);
        }
    }

    async getBreakPointsList(location: string): Promise<IBreakPoint[]> {
        const breakPoints: IBreakPoint[] = [];

        for (const thread of this.threads.values()) {
            const breakPoint = await thread.getBreakPointsList(location);
            breakPoints.push(...breakPoint);
        }

        return breakPoints;
    }

    async jumpToPage(url: string) {
        await this.page?.navigate({
            url
        });
    }

    getThreadList(): ThreadInfo[] {
        return [...this.sessionToThreadInfo.values()];
    }

    private async onThreadCreated(e: Protocol.Target.AttachedToTargetEvent) {
        console.error('Thread Created');

        const threadID = this.lastThreadId;
        this.lastThreadId++;
        
        const newThread = new Thread(this.debugAdapter, threadID, e.sessionId, this.fileRegistory);

        const _debugger = createDebuggerProxy(this.debugger!, e.sessionId);
        const runtime = createRuntimeProxy(this.runtime!, e.sessionId);

        await _debugger.enable({});
        await newThread.setChromeDebuggerApi(_debugger, runtime);

        for (const bpList of this.requestedBpLists.values()) {
            for (const bp of bpList) {
                await newThread.setBreakPoint(bp);
            }
        }

        this.threads.set(threadID, newThread);
        this.sessionToThreadInfo.set(e.sessionId, { threadID, threadName: e.targetInfo.url });

        this.debugAdapter.sendEvent(new ThreadEvent("started", threadID));
    }
    
    private onThreadDestroyed(e: Protocol.Target.DetachedFromTargetEvent) {
        console.error('Thread Destroyed');

        const threadInfo = this.sessionToThreadInfo.get(e.sessionId)!;

        this.threads.delete(threadInfo.threadID);
        this.sessionToThreadInfo.delete(e.sessionId);

        this.debugAdapter.sendEvent(new ThreadEvent("exited", threadInfo.threadID));
    }

    private onLoad(_: Protocol.Page.DomContentEventFiredEvent) {
        console.error('Page navigated.');
        this.reset();
    }
}