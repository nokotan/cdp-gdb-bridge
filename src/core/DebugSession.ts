import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import { DebugAdapter } from './DebugAdapterInterface';
import { FileLocation } from './DebugCommand';
import { WebAssemblyFileRegistory } from "./WebAssembly/FileRegistory";
import { Thread } from './DebugThread';
import { createDebuggerProxy, createRuntimeProxy } from './CDP/CDPProxy';
import { ThreadEvent } from '@vscode/debugadapter';
import { BreakPointsManager, ResolvedBreakPoint } from './BreakPoint/BreakPointsManager';

export interface ThreadInfo {
    threadID: number;
    threadName: string;
}

export class DebugSession {
    private threads: Map<number, Thread> = new Map();
    private sessionToThreadInfo: Map<string, ThreadInfo> = new Map();
    private breakpoints: BreakPointsManager = new BreakPointsManager();

    private debugger?: ProtocolApi.DebuggerApi;
    private page?: ProtocolApi.PageApi;
    private runtime?: ProtocolApi.RuntimeApi;
    private target?: ProtocolApi.TargetApi;

    private defaultThread?: Thread;

    private debugAdapter: DebugAdapter;
    private lastThreadId = 1;
    private focusedThreadId = 0;

    serverRoot = "";
    webRoot = "";

    constructor(_debugAdapter: DebugAdapter) {
        this.debugAdapter = _debugAdapter;
    }

    setChromeDebuggerApi(_debugger: ProtocolApi.DebuggerApi, _page: ProtocolApi.PageApi, _runtime: ProtocolApi.RuntimeApi, _target?: ProtocolApi.TargetApi) {
        this.debugger = _debugger;
        this.page = _page;
        this.runtime = _runtime;
        this.target = _target;

        if (!this.target) {
            console.error("target api disabled");
        }

        this.page?.on("loadEventFired", (e) => void this.onLoad(e));
        this.target?.on("attachedToTarget", (e) => void this.onThreadCreated(e));
        this.target?.on("detachedFromTarget", (e) => void this.onThreadDestroyed(e));

        this.defaultThread = new Thread(this.debugAdapter, 0, "", this.breakpoints);
        this.defaultThread.setChromeDebuggerApi(this.debugger, this.runtime);

        this.threads.set(0, this.defaultThread);
    }

    async activate() {
        await this.target?.setDiscoverTargets({ discover: true });
        await this.target?.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        await this.defaultThread?.activate();
    }

    async deactivate() {
        await this.defaultThread?.deactivate();
    }

    private reset() {
        this.threads.clear();
        this.sessionToThreadInfo.clear();
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
        const frames = await thread?.getStackFrames() || [];

        if (this.serverRoot) {
            for (const frame of frames) {
                if (frame.file.startsWith(this.serverRoot)) {
                    frame.file = frame.file.replace(this.serverRoot, this.webRoot);
                }
            }
        }
        
        return frames;
    }

    setFocusedThread(threadId: number) {
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

    async setBreakPoint(location: FileLocation): Promise<ResolvedBreakPoint> {
        const id = this.breakpoints.setBreakPoint(location);

        for (const thread of this.threads.values()) {
            await thread.updateBreakPoint();
        }
       
        return { id, verified: false };
    }

    async removeBreakPoint(id: number) {
        this.breakpoints.removeBreakPoint(id);

        for (const thread of this.threads.values()) {
            await thread.updateBreakPoint();
        }
    }

    async removeAllBreakPoints(path: string) {
        this.breakpoints.removeAllBreakPoint(path);

        for (const thread of this.threads.values()) {
            await thread.updateBreakPoint();
        }
    }

    async getBreakPointsList(location: string): Promise<ResolvedBreakPoint[]> {
        const breakPoints: ResolvedBreakPoint[] = [];

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
        
        const newThread = new Thread(this.debugAdapter, threadID, e.sessionId, this.breakpoints);

        const _debugger = createDebuggerProxy(this.debugger!, e.sessionId);
        const runtime = createRuntimeProxy(this.runtime!, e.sessionId);

        newThread.setChromeDebuggerApi(_debugger, runtime);
        await newThread.activate();
        await newThread.updateBreakPoint();

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