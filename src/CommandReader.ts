import type ProtocolProxyApi from 'devtools-protocol/types/protocol-proxy-api';
import { createInterface } from 'readline';

export class CommandReader {
    private browserDebugger: ProtocolProxyApi.DebuggerApi

    constructor(_debugger: ProtocolProxyApi.DebuggerApi) {
        this.browserDebugger = _debugger;
    }

    start(): Promise<void> {
        return new Promise(
            (resolve, _) => {
                const inputReader = createInterface({ input: process.stdin });

                inputReader.on("line", line => {
                    if (line == 'q')
                    {                
                        resolve();
                        return;
                    }
                    
                })
            }
        )
    }
}