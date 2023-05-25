import { DebuggerCommand, DebuggerBreakPointCommand } from '../core/DebugCommand';
import { createInterface } from 'readline';

export class CommandReader {
    private session: DebuggerCommand & DebuggerBreakPointCommand;
    private commandList: Map<string, (args?: string | number) => void>;

    constructor(_session: DebuggerCommand & DebuggerBreakPointCommand) {
        this.session = _session;

        this.commandList = new Map<string, (args?:any) => void>([
            [ 'r', (url: string) => this.jumpToPage(url) ],
            [ 'c', () => this.continue() ],
            [ 'n', () => this.stepOver() ],
            [ 's', () => this.stepIn() ],
            [ 'u', () => this.stepOut() ],
            [ 'b', (location: string) => this.setBreakPoint(location) ],
            [ 'd', (id: number) => this.removeBreakPoint(id) ],
            [ 'l', () => this.showLine() ],
            [ 'il', () => this.listVariable() ],
            [ 'ig', () => this.listGlobalVariable() ],
            [ 'p', (expr: string) => this.dumpVariable(expr) ],
        ]);
    }

    start(): Promise<void> {
        return new Promise(
            (resolve) => {
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

                    this.commandList.get(commandArgs[0])?.apply(this.session, [ commandArgs.slice(1).join(" ") ]);
                })
            }
        )
    }

    async stepOver() {
        await this.session.stepOver();
    }

    async stepIn() {
        await this.session.stepIn();
    }

    async stepOut() {
        await this.session.stepOut();
    }

    async continue() {
        await this.session.continue();
    }

    async getStackFrames() {
        const frames = await this.session.getStackFrames();

        frames.forEach((x, i) => {
            console.log(`${i}: ${x.name}`)
        })
    }

    async showLine(): Promise<void> {
        await this.session.showLine();
    }

    async listVariable() {
        const variables = await this.session.listVariable();

        variables.forEach(x => {
            console.log(`${x.name}: ${x.type}`)
        })
    }

    async listGlobalVariable() {
        const variables = await this.session.listGlobalVariable();

        variables.forEach(x => {
            console.log(`${x.name}: ${x.type}`)
        })
    }

    async dumpVariable(expr: string) {
        const text = await this.session.dumpVariable(expr);
        console.log(text)
    }

    async setBreakPoint(location: string) {
        const fileInfo = location.split(':');
        
        if (fileInfo.length < 2)
        {
            console.log('invalid file spec.\n')
            return;
        }

        const debugline = Number(fileInfo.pop());
        const debugfilename = fileInfo.join(":");
        const bp = await this.session.setBreakPoint({
            file: debugfilename,
            line: debugline
        });

        if (bp.id) {
            console.log(`Set Breakpoint: ${bp.id}`)
        }
    }

    async removeBreakPoint(id: number) {
        await this.session.removeBreakPoint(id);
    }

    async jumpToPage(url: string) {
        await this.session.jumpToPage(url);
    }
}