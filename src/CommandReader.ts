import { DebuggerCommand } from './DebugSession';
import { createInterface } from 'readline';

export class CommandReader {
    private session: DebuggerCommand;
    private commandList: Map<string, Function>;

    constructor(_session: DebuggerCommand) {
        this.session = _session;

        this.commandList = new Map<string, Function>([
            [ 'c', this.session.continue ],
            [ 'n', this.session.stepOver ],
            [ 's', this.session.stepIn ],
            [ 'u', this.session.stepOut ],
            [ 'b', this.session.setBreakPoint ],
            [ 'd', this.session.removeBreakPoint ],
            [ 'l', this.session.showLine ],
            [ 'i', this.session.listVariable ],
            [ 'p', this.session.dumpVariable ],
        ]);
    }

    start(): Promise<void> {
        return new Promise(
            (resolve, _) => {
                const inputReader = createInterface({ input: process.stdin });

                inputReader.on("line", line => {
                    const commandArgs = line.split(' ');

                    if (commandArgs.length == 0) {
                        return;
                    }

                    if (commandArgs[0] == 'q')
                    {             
                        inputReader.close();   
                        resolve();
                        return;
                    }

                    this.commandList.get(commandArgs[0])?.apply(this.session, commandArgs.slice(1));
                })
            }
        )
    }
}