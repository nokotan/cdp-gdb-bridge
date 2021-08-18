import type Protocol from 'devtools-protocol/types/protocol';
import { DwarfDebugSymbolContainer } from "../crates/dwarf/pkg"

export class WebAssemblyFile {

    scriptID: Protocol.Runtime.ScriptId;
    private dwarf: DwarfDebugSymbolContainer;

    constructor(_scriptID: Protocol.Runtime.ScriptId, wasm: DwarfDebugSymbolContainer) {
        this.scriptID = _scriptID;
        this.dwarf = wasm;
    }

    free() {
        this.dwarf.free();
    }

    findFileFromLocation(loc: Protocol.Debugger.Location) {
        return this.dwarf.find_file_from_address(loc.columnNumber!)
    }

    findAddressFromFileLocation(file: string, lineNumber: number) {
        const fileRef = this.dwarf.find_file(file);
        return fileRef && fileRef.find_address_from_line(lineNumber);
    }
}
