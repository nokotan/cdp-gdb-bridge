/* eslint @typescript-eslint/no-unsafe-return: 1 */
/* eslint @typescript-eslint/no-unsafe-assignment: 1 */

import { ProtocolProxyApi } from 'devtools-protocol/types/protocol-proxy-api';

export function createDebuggerProxy(_debugger: ProtocolProxyApi.DebuggerApi, sessionId: string): ProtocolProxyApi.DebuggerApi {
    const handlerObject = {
        get(_target: object, methodName: string): any {
            if (methodName === "on") {
                return function(eventName: string, ...args: any[]) {
                    const originalFunction = Reflect.get(_debugger, eventName) as (id: string, ...args: any[]) => any;
                    return originalFunction.apply(_debugger, [sessionId, ...args]);
                }
            } else {
                return function(...args: any[]) {
                    const originalFunction = Reflect.get(_debugger, methodName) as (...args: any[]) => any;
                    return originalFunction.apply(_debugger, [...args, sessionId]);
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
                return function(eventName: string, ...args: any[]) {
                    const originalFunction = Reflect.get(_debugger, eventName) as (id: string, ...args: any[]) => any;
                    return originalFunction.apply(_debugger, [sessionId, ...args]);
                }
            } else {
                return function(...args: any[]) {
                    const originalFunction = Reflect.get(_debugger, methodName) as (...args: any[]) => any;
                    return originalFunction.apply(_debugger, [...args, sessionId]);
                }
            }
        }
    };

    return new Proxy({}, handlerObject) as ProtocolProxyApi.RuntimeApi;
}