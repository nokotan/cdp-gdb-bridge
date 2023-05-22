import { Protocol } from 'devtools-protocol/types/protocol';

export interface RuntimeApi {
    /**
     * Add handler to promise with given promise object id.
     */
    awaitPromise(params: Protocol.Runtime.AwaitPromiseRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.AwaitPromiseResponse>;

    /**
     * Calls function with given declaration on the given object. Object group of the result is
     * inherited from the target object.
     */
    callFunctionOn(params: Protocol.Runtime.CallFunctionOnRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.CallFunctionOnResponse>;

    /**
     * Compiles expression.
     */
    compileScript(params: Protocol.Runtime.CompileScriptRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.CompileScriptResponse>;

    /**
     * Disables reporting of execution contexts creation.
     */
    disable(sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Discards collected exceptions and console API calls.
     */
    discardConsoleEntries(sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Enables reporting of execution contexts creation by means of `executionContextCreated` event.
     * When the reporting gets enabled the event will be sent immediately for each existing execution
     * context.
     */
    enable(sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Evaluates expression on global object.
     */
    evaluate(params: Protocol.Runtime.EvaluateRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.EvaluateResponse>;

    /**
     * Returns the isolate id.
     */
    getIsolateId(sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.GetIsolateIdResponse>;

    /**
     * Returns the JavaScript heap usage.
     * It is the total usage of the corresponding isolate not scoped to a particular Runtime.
     */
    getHeapUsage(sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.GetHeapUsageResponse>;

    /**
     * Returns properties of a given object. Object group of the result is inherited from the target
     * object.
     */
    getProperties(params: Protocol.Runtime.GetPropertiesRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.GetPropertiesResponse>;

    /**
     * Returns all let, const and class variables from global scope.
     */
    globalLexicalScopeNames(params: Protocol.Runtime.GlobalLexicalScopeNamesRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.GlobalLexicalScopeNamesResponse>;

    queryObjects(params: Protocol.Runtime.QueryObjectsRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.QueryObjectsResponse>;

    /**
     * Releases remote object with given id.
     */
    releaseObject(params: Protocol.Runtime.ReleaseObjectRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Releases all remote objects that belong to a given group.
     */
    releaseObjectGroup(params: Protocol.Runtime.ReleaseObjectGroupRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Tells inspected instance to run if it was waiting for debugger to attach.
     */
    runIfWaitingForDebugger(sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Runs script with given id in a given context.
     */
    runScript(params: Protocol.Runtime.RunScriptRequest, sessionId: Protocol.Target.SessionID): Promise<Protocol.Runtime.RunScriptResponse>;

    /**
     * Enables or disables async call stacks tracking.
     */
    setAsyncCallStackDepth(params: Protocol.Runtime.SetAsyncCallStackDepthRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    setCustomObjectFormatterEnabled(params: Protocol.Runtime.SetCustomObjectFormatterEnabledRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    setMaxCallStackSizeToCapture(params: Protocol.Runtime.SetMaxCallStackSizeToCaptureRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Terminate current or next JavaScript execution.
     * Will cancel the termination when the outer-most script execution ends.
     */
    terminateExecution(sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * If executionContextId is empty, adds binding with the given name on the
     * global objects of all inspected contexts, including those created later,
     * bindings survive reloads.
     * Binding function takes exactly one argument, this argument should be string,
     * in case of any other input, function throws an exception.
     * Each binding function call produces Runtime.bindingCalled notification.
     */
    addBinding(params: Protocol.Runtime.AddBindingRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * This method does not remove binding function from global object but
     * unsubscribes current runtime agent from Runtime.bindingCalled notifications.
     */
    removeBinding(params: Protocol.Runtime.RemoveBindingRequest, sessionId: Protocol.Target.SessionID): Promise<void>;

    /**
     * Notification is issued every time when binding is called.
     */
    on(event: 'bindingCalled', sessionId: Protocol.Target.SessionID, listener: (params: Protocol.Runtime.BindingCalledEvent) => void): void;

    /**
     * Issued when console API was called.
     */
    on(event: 'consoleAPICalled', sessionId: Protocol.Target.SessionID, listener: (params: Protocol.Runtime.ConsoleAPICalledEvent) => void): void;

    /**
     * Issued when unhandled exception was revoked.
     */
    on(event: 'exceptionRevoked', sessionId: Protocol.Target.SessionID, listener: (params: Protocol.Runtime.ExceptionRevokedEvent) => void): void;

    /**
     * Issued when exception was thrown and unhandled.
     */
    on(event: 'exceptionThrown', sessionId: Protocol.Target.SessionID, listener: (params: Protocol.Runtime.ExceptionThrownEvent) => void): void;

    /**
     * Issued when new execution context is created.
     */
    on(event: 'executionContextCreated', sessionId: Protocol.Target.SessionID, listener: (params: Protocol.Runtime.ExecutionContextCreatedEvent) => void): void;

    /**
     * Issued when execution context is destroyed.
     */
    on(event: 'executionContextDestroyed', sessionId: Protocol.Target.SessionID, listener: (params: Protocol.Runtime.ExecutionContextDestroyedEvent) => void): void;

    /**
     * Issued when all executionContexts were cleared in browser
     */
    on(event: 'executionContextsCleared', sessionId: Protocol.Target.SessionID, listener: () => void): void;

    /**
     * Issued when object should be inspected (for example, as a result of inspect() command line API
     * call).
     */
    on(event: 'inspectRequested', sessionId: Protocol.Target.SessionID, listener: (params: Protocol.Runtime.InspectRequestedEvent) => void): void;

}