import { ProtocolProxyApi } from 'devtools-protocol/types/protocol-proxy-api';
import { RuntimeApi } from './CDPRuntimeApi';
import { CDPDebugger } from './CDPDebuggerApi';

export function createDebuggerProxy(_debugger: ProtocolProxyApi.DebuggerApi, sessionId: string): ProtocolProxyApi.DebuggerApi {
    const handlerObject = {
        get(_target: object, methodName: string): any {
            if (methodName === "on") {
                return function() {
                    const eventName = arguments[0];
                    const args = [...arguments].slice(1);
                    const originalFunction = Reflect.get(_debugger, eventName) as Function;
                    return originalFunction.apply(_debugger, [sessionId, ...args]);
                }
            } else {
                return function() {
                    const originalFunction = Reflect.get(_debugger, methodName) as Function;
                    return originalFunction.apply(_debugger, [...arguments, sessionId]);
                }
            }
        }
    };

    return new Proxy({}, handlerObject) as ProtocolProxyApi.DebuggerApi;
}

export function createRuntimeProxy(_debugger: ProtocolProxyApi.RuntimeApi, sessionId: string): ProtocolProxyApi.RuntimeApi {
    const handlerObject = {
        get(_target: object, methodName: string, receiver: any): any {
            if (methodName === "on") {
                return function() {
                    const eventName = arguments[0];
                    const args = [...arguments].slice(1);
                    const originalFunction = Reflect.get(_debugger, eventName) as Function;
                    return originalFunction.apply(_debugger, [sessionId, ...args]);
                }
            } else {
                return function() {
                    const originalFunction = Reflect.get(_debugger, methodName) as Function;
                    return originalFunction.apply(_debugger, [...arguments, sessionId]);
                }
            }
        }
    };

    return new Proxy({}, handlerObject) as ProtocolProxyApi.RuntimeApi;
}