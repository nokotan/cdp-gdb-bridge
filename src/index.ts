import CDP from 'chrome-remote-interface';
import { readFileSync, existsSync } from 'fs';
import { stdin, stdout } from 'process';
import { createInterface } from 'readline';
import { DwarfDebugFileWeakRef, DwarfDebugLineContainer, read_dwarf } from '../crates/dwarf/pkg/cdp_gdb_bridge'

async function main() {
    let client: CDP.Client | null = null;
    try {
        // connect to endpoint
        client = await CDP();
        // extract domains
        const { Debugger } = client;
        await Debugger.enable({});

        let wasmScriptID = '';
        let container: DwarfDebugLineContainer;
        let lastFrameFile: string = '';
        let lastFrameLine: number = 0;
        
        Debugger.on("scriptParsed", async (e) => {
            console.log(e.url);

            if (e.scriptLanguage == "WebAssembly") {
                wasmScriptID = e.scriptId;

                console.log(`Start Loading ${e.url}...`);

                const response = await Debugger.getScriptSource({ scriptId: e.scriptId });
                const buffer = Buffer.from(response?.bytecode!, 'base64');

                // dump_file(new Uint8Array(buffer));
                container = read_dwarf(new Uint8Array(buffer));

                console.log(`Found ${container.size()} files`);
            }
        });

        Debugger.on("paused", async (e) => {
            console.log("Hit breakpoint");
            const pausedLocation = e.callFrames[0].location;

            if (pausedLocation.scriptId == wasmScriptID) {
                const loc = container.find_address(pausedLocation.columnNumber!);
                
                if (loc) {
                    lastFrameFile = loc.file();
                    lastFrameLine = loc.line();

                    console.log(`paused at ${lastFrameFile}:${lastFrameLine}`)
                } else {
                    lastFrameFile = '';
                    lastFrameLine = 0;

                    console.log(`paused at <${e.callFrames[0].url}+${pausedLocation.columnNumber!}>`)
                }
            }
        })

        function mainLoop(): Promise<void> {
            return new Promise((resolve, reject) => {
                const inputReader = createInterface({ input: process.stdin });

                stdout.write('(gdb-cdp) ');

                inputReader.on("line", async line => {
                    if (line == 'q')
                    {                
                        inputReader.close();
                        resolve();
                        return;
                    }
                    else if (line == 'n') {
                        await Debugger.stepOver({});
                    }
                    else if (line == 's') {
                        await Debugger.stepInto({});
                    }
                    else if (line == 'u') {
                        await Debugger.stepOut();
                    }
                    else if (line == 'c') {
                        await Debugger.resume({});
                    }
                    else if (line == 'l') {
                        if (existsSync(lastFrameFile)) {
                            const lines = readFileSync(lastFrameFile, { encoding: 'utf8' }).split('\n');
                            const startLine = Math.max(0, lastFrameLine - 10);
                            const endLine = Math.min(lines.length - 1, lastFrameLine + 10);

                            for (let i = startLine; i <= endLine; i++) {
                                console.log((i + 1 == lastFrameLine ? '->' : '  ') + ` ${i}  ${lines[i]}`);
                            }
                        } else {
                            console.log('not available.')
                        }
                    }
                    else if (line.startsWith('d ')) {
                        const args = line.split(' ');
        
                        if (args.length < 2) {
                            return;
                        }

                        const bpID = args[1];

                        await Debugger.removeBreakpoint({
                            breakpointId: bpID
                        })
                    }
                    else if (line.startsWith('b ')) {
                        const args = line.split(' ');
        
                        if (args.length < 2) {
                            return;
                        }
        
                        const fileInfo = args[1].split(':');
        
                        if (fileInfo.length < 2)
                        {
                            return;
                        }
        
                        const debugfilename = fileInfo[0];
                        const debuglinenumber = Number(fileInfo[1]);
        
                        let fileRef = container.find_file(debugfilename);
        
                        if (fileRef == undefined)
                        {
                            return;
                        }
        
                        let Addr: number = 0;
        
                        for (let i = 0; i < fileRef.size(); i++) {
                            const lineInfo = fileRef.at(i);
        
                            if (lineInfo.line() == debuglinenumber) {
                                Addr = lineInfo.address();
                                break;
                            }
                        }
        
                        const bpId = await Debugger.setBreakpoint({ 
                            location: {
                                scriptId: wasmScriptID,
                                lineNumber: 0,
                                columnNumber: Addr
                            }
                        });

                        console.log(`set breakpoint ${ bpId.breakpointId }`);
                    }
                    stdout.write('(gdb-cdp) ');
                });
            })
        }

        await mainLoop();
    } catch (err) {
        console.error(err);
    } finally {
        if (client) {
            console.log('session closed.');
            client.close();
        }
    }
}

main();
