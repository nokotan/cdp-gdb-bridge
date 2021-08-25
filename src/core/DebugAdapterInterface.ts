import { DebugProtocol } from 'vscode-debugprotocol';

export interface DebugAdapter {
    sendEvent(event: DebugProtocol.Event): void;
}