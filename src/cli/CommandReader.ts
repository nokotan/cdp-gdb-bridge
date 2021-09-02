import { DebuggerCommand, IBreakPoint, Variable } from '../core/DebugSession';
import { createInterface } from 'readline';

export class CommandReader {
    private session: DebuggerCommand;
    private commandList: Map<string, Function>;

    constructor(_session: DebuggerCommand) {
        this.session = _session;

        this.commandList = new Map<string, Function>([
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
        console.log(`${text}`)
    }

    async setBreakPoint(location: string) {
        const bp = await this.session.setBreakPoint(location);
        console.log(`Set Breakpoint: ${bp.id}`)
    }

    async removeBreakPoint(id: number) {
        await this.session.removeBreakPoint(id);
    }

    async jumpToPage(url: string) {
        await this.session.jumpToPage(url);
    }
}