import type Protocol from 'devtools-protocol/types/protocol';
import { WebAssemblyFile } from "./File"
import { WebAssemblyDebugState } from '../DebugCommand';
import { DwarfDebugSymbolContainer } from '../../../crates/dwarf/pkg';

export class WebAssemblyFileRegistory {

    sources: Map<string, WebAssemblyFile> = new Map();
    jsFiles: Map<string, string> = new Map();

    reset() {
        for (const [_, item] of this.sources) {
            item.free();
        }

        this.sources.clear();
        this.jsFiles.clear();
    }

    loadWebAssembly(url: string, scriptID: string, buffer: Buffer) {
        if (this.sources.has(scriptID)) {
            return;
        }

        const container = DwarfDebugSymbolContainer.new(new Uint8Array(buffer));
        this.sources.set(scriptID, new WebAssemblyFile(scriptID, url, container));
    }

    loadJavaScript(url: string, scriptID: string) {
        this.jsFiles.set(scriptID, url);
    }

    findFileFromLocation(loc: Protocol.Debugger.Location) {
        const wasmLocation = Array.from(this.sources.values()).filter(
                    x => x.scriptID == loc.scriptId
                )[0]?.findFileFromLocation(loc);
        const jsUrl = this.jsFiles.get(loc.scriptId) || "";
        return wasmLocation || {
            line: loc.lineNumber + 1,
            file() {
                return jsUrl;
            }
        };
    }

    findAddressFromFileLocation(file: string, line: number) {
        for (const [_, x] of this.sources) {
            const address = x.findAddressFromFileLocation(file, line);

            if (address) {
                return {
                    scriptId: x.scriptID,
                    url: x.url,
                    line: 0,
                    column: address
                };
            }
        }

        return undefined;
    }

    getVariablelistFromAddress(address: number) {
        for (const [_, x] of this.sources) {
            const list = x.dwarf.variable_name_list(address);

            if (list && list.size() > 0) {
                return list;
            }
        }

        return undefined;
    }

    getGlobalVariablelist(inst: number) {
        const list = [];

        for (const [_, x] of this.sources) {
            list.push(x.dwarf.global_variable_name_list(inst));
        }

        return list;
    }

    getVariableValue(expr: string, address: number, state: WebAssemblyDebugState) {
        for (const [_, x] of this.sources) {
            const info = x.dwarf.get_variable_info(
                expr,
                state.locals,
                state.globals,
                state.stacks,
                address
            );

            if (info) {
                return info;
            }
        }

        return undefined;
    }
}