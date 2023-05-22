import type Protocol from 'devtools-protocol/types/protocol';
import { DwarfDebugSymbolContainer, WasmLineInfo } from "../../../crates/dwarf/pkg"

export class WebAssemblyFile {

    scriptID: Protocol.Runtime.ScriptId;
    url: string;
    dwarf: DwarfDebugSymbolContainer;

    constructor(_scriptID: Protocol.Runtime.ScriptId, url: string, wasm: DwarfDebugSymbolContainer) {
        this.scriptID = _scriptID;
        this.url = url;
        this.dwarf = wasm;
    }

    free() {
        this.dwarf.free();
    }

    findFileFromLocation(loc: Protocol.Debugger.Location) {
        return this.dwarf.find_file_info_from_address(loc.columnNumber!)
    }

    findAddressFromFileLocation(file: string, lineNumber: number) {
        const wasmLineInfo = WasmLineInfo.new(file, lineNumber);
        const address = this.dwarf.find_address_from_file_info(wasmLineInfo);
        wasmLineInfo.free();
        return address;
    }
}
