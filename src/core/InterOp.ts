import type Protocol from 'devtools-protocol/types/protocol';
import type ProtocolApi from 'devtools-protocol/types/protocol-proxy-api';
import { WasmValue, WasmValueVector } from "../../crates/dwarf/pkg";

export async function createWasmValueStore(runtime: ProtocolApi.RuntimeApi, data: Protocol.Runtime.PropertyDescriptor[]) {

    const store = WasmValueVector.new();

    await Promise.all(
        data.map(async x => 
        {
            // TODO: no longer needed? (node v14.x does not support memory dump on evaluateOnCallFrame)
            if (x.value?.type == 'number') {
                store.push(WasmValue.from_i32(Number(x.value?.value as string)));
                return;
            }
            else if (x.value?.type == 'bigint') {
                store.push(WasmValue.from_i64(BigInt(x.value?.value as string)));
                return;
            }

            const result = await runtime.getProperties({
                objectId: x.value!.objectId!,
                ownProperties: true
            });

            const type =result.result[0].value!.value as string;
            // i64 is represented as BigInt in javascript, which is unserializable.
            // Instead of 'value' property, BigInt value is stored in unserializableValue as a format of '0n',
            // therefore we need to remove the last 'n' character to cast BigInt from string.
            const value = result.result[1].value!.value as number || result.result[1].value!.unserializableValue?.slice(0, -1) as string;
            
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