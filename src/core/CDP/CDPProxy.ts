import { ProtocolProxyApi } from 'devtools-protocol/types/protocol-proxy-api';

export function createDebuggerProxy(_debugger: ProtocolProxyApi.DebuggerApi, sessionId: string): ProtocolProxyApi.DebuggerApi {
    const handlerObject = {
        apply(target: object, thisArg: any, argArray: any[]): any {
            const args = [...argArray, sessionId];
            return Reflect.apply(target as Function, thisArg, args);
        }
    };

    return new Proxy(_debugger, handlerObject) as ProtocolProxyApi.DebuggerApi;
}

export function createRuntimeProxy(_debugger: ProtocolProxyApi.RuntimeApi, sessionId: string): ProtocolProxyApi.RuntimeApi {
    const handlerObject = {
        apply(target: object, thisArg: any, argArray: any[]): any {
            const args = [...argArray, sessionId];
            return Reflect.apply(target as Function, thisArg, args);
        }
    };

    return new Proxy(_debugger, handlerObject) as ProtocolProxyApi.RuntimeApi;
}