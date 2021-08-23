import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import { WasmValue, WasmValueVector } from "../crates/dwarf/pkg/wasm_dwarf_alanyser";

export async function createWasmValueStore(runtime: ProtocolApi.RuntimeApi, data: Protocol.Runtime.PropertyDescriptor[]) {

    const store = WasmValueVector.new();

    await Promise.all(
        data.map(async x => 
        {
            const result = await runtime.getProperties({
                objectId: x.value!.objectId!
            });

            const type = result.result[0].value!.value!;
            const value = result.result[1].value!.value!;
            
            switch (type) {
                case 'i32':
                    store.push(WasmValue.from_i32(Number(value)));
                    break;
                case 'i64':
                    store.push(WasmValue.from_i64(BigInt(value)));
                    break;
                case 'f32':
                    store.push(WasmValue.from_f32(Number(value)));
                    break;
                case 'f64':
                    store.push(WasmValue.from_f64(Number(value)));
                    break;
            }
        })
    );

    return store;
}