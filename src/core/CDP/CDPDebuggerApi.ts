import { Protocol } from 'devtools-protocol/types/protocol';

export interface CDPDebugger {
    /**
         * Continues execution until specific location is reached.
         */
    continueToLocation(params: Protocol.Debugger.ContinueToLocationRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Disables debugger for given page.
     */
    disable(sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Enables debugger for the given page. Clients should not assume that the debugging has been
     * enabled until the result for this command is received.
     */
    enable(params: Protocol.Debugger.EnableRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.EnableResponse>;

    /**
     * Evaluates expression on a given call frame.
     */
    evaluateOnCallFrame(params: Protocol.Debugger.EvaluateOnCallFrameRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.EvaluateOnCallFrameResponse>;

    /**
     * Returns possible locations for breakpoint. scriptId in start and end range locations should be
     * the same.
     */
    getPossibleBreakpoints(params: Protocol.Debugger.GetPossibleBreakpointsRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.GetPossibleBreakpointsResponse>;

    /**
     * Returns source for the script with given id.
     */
    getScriptSource(params: Protocol.Debugger.GetScriptSourceRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.GetScriptSourceResponse>;

    /**
     * This command is deprecated. Use getScriptSource instead.
     */
    getWasmBytecode(params: Protocol.Debugger.GetWasmBytecodeRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.GetWasmBytecodeResponse>;

    /**
     * Returns stack trace with given `stackTraceId`.
     */
    getStackTrace(params: Protocol.Debugger.GetStackTraceRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.GetStackTraceResponse>;

    /**
     * Stops on the next JavaScript statement.
     */
    pause(): Promise<void>;

    pauseOnAsyncCall(params: Protocol.Debugger.PauseOnAsyncCallRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Removes JavaScript breakpoint.
     */
    removeBreakpoint(params: Protocol.Debugger.RemoveBreakpointRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Restarts particular call frame from the beginning.
     */
    restartFrame(params: Protocol.Debugger.RestartFrameRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.RestartFrameResponse>;

    /**
     * Resumes JavaScript execution.
     */
    resume(params: Protocol.Debugger.ResumeRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Searches for given string in script content.
     */
    searchInContent(params: Protocol.Debugger.SearchInContentRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.SearchInContentResponse>;

    /**
     * Enables or disables async call stacks tracking.
     */
    setAsyncCallStackDepth(params: Protocol.Debugger.SetAsyncCallStackDepthRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Replace previous blackbox patterns with passed ones. Forces backend to skip stepping/pausing in
     * scripts with url matching one of the patterns. VM will try to leave blackboxed script by
     * performing 'step in' several times, finally resorting to 'step out' if unsuccessful.
     */
    setBlackboxPatterns(params: Protocol.Debugger.SetBlackboxPatternsRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Makes backend skip steps in the script in blackboxed ranges. VM will try leave blacklisted
     * scripts by performing 'step in' several times, finally resorting to 'step out' if unsuccessful.
     * Positions array contains positions where blackbox state is changed. First interval isn't
     * blackboxed. Array should be sorted.
     */
    setBlackboxedRanges(params: Protocol.Debugger.SetBlackboxedRangesRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Sets JavaScript breakpoint at a given location.
     */
    setBreakpoint(params: Protocol.Debugger.SetBreakpointRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.SetBreakpointResponse>;

    /**
     * Sets instrumentation breakpoint.
     */
    setInstrumentationBreakpoint(params: Protocol.Debugger.SetInstrumentationBreakpointRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.SetInstrumentationBreakpointResponse>;

    /**
     * Sets JavaScript breakpoint at given location specified either by URL or URL regex. Once this
     * command is issued, all existing parsed scripts will have breakpoints resolved and returned in
     * `locations` property. Further matching script parsing will result in subsequent
     * `breakpointResolved` events issued. This logical breakpoint will survive page reloads.
     */
    setBreakpointByUrl(params: Protocol.Debugger.SetBreakpointByUrlRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.SetBreakpointByUrlResponse>;

    /**
     * Sets JavaScript breakpoint before each call to the given function.
     * If another function was created from the same source as a given one,
     * calling it will also trigger the breakpoint.
     */
    setBreakpointOnFunctionCall(params: Protocol.Debugger.SetBreakpointOnFunctionCallRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.SetBreakpointOnFunctionCallResponse>;

    /**
     * Activates / deactivates all breakpoints on the page.
     */
    setBreakpointsActive(params: Protocol.Debugger.SetBreakpointsActiveRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Defines pause on exceptions state. Can be set to stop on all exceptions, uncaught exceptions or
     * no exceptions. Initial pause on exceptions state is `none`.
     */
    setPauseOnExceptions(params: Protocol.Debugger.SetPauseOnExceptionsRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Changes return value in top frame. Available only at return break position.
     */
    setReturnValue(params: Protocol.Debugger.SetReturnValueRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Edits JavaScript source live.
     */
    setScriptSource(params: Protocol.Debugger.SetScriptSourceRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Debugger.SetScriptSourceResponse>;

    /**
     * Makes page not interrupt on any pauses (breakpoint, exception, dom exception etc).
     */
    setSkipAllPauses(params: Protocol.Debugger.SetSkipAllPausesRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Changes value of variable in a callframe. Object-based scopes are not supported and must be
     * mutated manually.
     */
    setVariableValue(params: Protocol.Debugger.SetVariableValueRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Steps into the function call.
     */
    stepInto(params: Protocol.Debugger.StepIntoRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Steps out of the function call.
     */
    stepOut(sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Steps over the statement.
     */
    stepOver(params: Protocol.Debugger.StepOverRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Fired when breakpoint is resolved to an actual script and location.
     */
    on(event: 'breakpointResolved', listener: (params: Protocol.Debugger.BreakpointResolvedEvent, sessionId?: string) => void): void;

    /**
     * Fired when the virtual machine stopped on breakpoint or exception or any other stop criteria.
     */
    on(event: 'paused', listener: (params: Protocol.Debugger.PausedEvent, sessionId?: string) => void): void;

    /**
     * Fired when the virtual machine resumed execution.
     */
    on(event: 'resumed', listener: (sessionId?: string) => void): void;

    /**
     * Fired when virtual machine fails to parse the script.
     */
    on(event: 'scriptFailedToParse', listener: (params: Protocol.Debugger.ScriptFailedToParseEvent, sessionId?: string) => void): void;

    /**
     * Fired when virtual machine parses script. This event is also fired for all known and uncollected
     * scripts upon enabling debugger.
     */
    on(event: 'scriptParsed', listener: (params: Protocol.Debugger.ScriptParsedEvent, sessionId?: string) => void): void;

}