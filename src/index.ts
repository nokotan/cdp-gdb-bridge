import CDP from 'chrome-remote-interface';
import { DebugSessionManager } from './DebugSession'
import { CommandReader } from './CommandReader'

async function main() {
    let client: CDP.Client | null = null;
    try {
        // connect to endpoint
        client = await CDP();
        // extract domains
        const { Debugger, Page, Runtime } = client;

        await Debugger.enable({});
        await Page.enable();
        await Runtime.enable();

        const manager = new DebugSessionManager(Debugger, Page, Runtime);
        const commandReader = new CommandReader(manager);

        await commandReader.start();
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
