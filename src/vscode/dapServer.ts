import { DebugProtocol } from 'vscode-debugprotocol';
import {
	LoggingDebugSession,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, TerminatedEvent,
	InitializedEvent,
	OutputEvent
} from 'vscode-debugadapter';
import { launch } from 'chrome-launcher';
import CDP from 'chrome-remote-interface';
import { DebugSessionManager } from '../core/DebugSession'
import { Variable } from '../core/DebugCommand';
import { DebugAdapter } from '../core/DebugAdapterInterface';
import { basename } from 'path'
import { ChildProcess, spawn } from 'child_process';
import { createConnection } from 'net';

/**
 * This interface describes the wasm specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the wasm extension.
 * The interface should always match this schema.
 */
interface IChromeLaunchRequestArguments {
	type: 'wasm-chrome';

	/** An absolute url to the "program" to debug. */
	url?: string;

	port?: number;
}

interface INodeLaunchRequestArguments {
	type: 'wasm-node';
	
	/** An absolute url to the "program" to debug. */
	program?: string;

	port?: number;

	/** An absolute url to the "program" to debug. */
	node?: string;
}

export interface Logger {
	append(text: string): void;
	appendLine(text: string): void;
}

export type ILaunchRequestArguments = IChromeLaunchRequestArguments | INodeLaunchRequestArguments;

type LaunchRequestArgument = ILaunchRequestArguments & DebugProtocol.LaunchRequestArguments;



export class VSCodeDebugSession extends LoggingDebugSession implements DebugAdapter {

    private session: DebugSessionManager;

	private client?: CDP.Client;

    private launchedProcess?: ChildProcess;

	private logger?: Logger; 

	private _variableHandles = new Handles<'locals' | 'globals'>();

    constructor(logger?: Logger) {
        super();

		this.session = new DebugSessionManager(this);
		this.logger = logger;
    }

	private onTerminated() {
		this.sendEvent(new TerminatedEvent());
		this.launchedProcess = undefined;
	} 

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

        // build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

        this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
    }

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: LaunchRequestArgument) {
		// connect to endpoint
		this.client = await CDP({
            port: args.port
        });

        // extract domains
        const { Debugger, Page, Runtime } = this.client;

		this.session.setChromeDebuggerApi(Debugger, Page, Runtime);

        await Debugger.enable({});
        await Runtime.enable();

		// nodejs don't have Page interface.
        if (Page) await Page.enable();

		this.sendResponse(response);
	}

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArgument) {
		const port = args.port || 9222;
	
		switch (args.type) {
			case 'wasm-chrome':
				const launchedProcess = await launch({
					startingUrl: args.url,
					port: port
				});

				this.launchedProcess = launchedProcess.process;
				break;
			case 'wasm-node':
				const nodeExecitable = args.node || "node";
				this.launchedProcess = spawn(nodeExecitable, [ `--inspect=${port}`, `${args.program}` ]);
				this.launchedProcess.on('exit', () => { console.error('Process Exited.') });
				// TODO: forward launched process log messages to vscode
				this.launchedProcess.stdout?.on('data', (d: Buffer) => { this.sendEvent(new OutputEvent(d.toString(), 'stdout')) });
				this.launchedProcess.stderr?.on('data', (d: Buffer) => { this.sendEvent(new OutputEvent(d.toString(), 'stderr')) });
				
				// TODO: check if node process is launched.
				await new Promise<void>((resolve, _) => {
					setTimeout(resolve, 200)
				});

				await new Promise<void>((resolve, reject) => {
					const client = createConnection(port);
					client.once('error', err => {
						client.removeAllListeners();
						client.end();
						client.destroy();
						client.unref();
						reject(err);
					});
					client.once('connect', () => {
						client.removeAllListeners();
						client.end();
						client.destroy();
						client.unref();
						resolve();
					});
				});
				break;
		}		

		this.launchedProcess.on('exit', () => { this.onTerminated(); });
		
        // connect to endpoint
        this.client = await CDP({
            port
        });

        // extract domains
        const { Debugger, Page, Runtime } = this.client;

		this.session.setChromeDebuggerApi(Debugger, Page, Runtime);

        await Debugger.enable({});
        await Runtime.enable();

		// nodejs don't have Page interface.
        if (Page) await Page.enable();

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

		const path = (args.source.path as string).replace(/\\/g, "/");
		const clientLines = args.lines || [];

		await this.session.removeAllBreakPoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints0 = clientLines.map(async l => {
			const fileSpec = {
				file: path,
				line: l
			};
			const { verified, line, id } = await this.session.setBreakPoint(fileSpec)!;
			const bp = new Breakpoint(verified, line) as DebugProtocol.Breakpoint;
			bp.id= id;
			return bp;
		});
		const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);
	}

	protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request) {

		if (args.source.path) {
			const bps = await this.session.getBreakPointsList(`${args.source.path}:${args.line}`);
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: col.column
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	async shutdown() {
		if (this.client) {
            console.error('session closed.');
            await this.client.close();
        }

        if (this.launchedProcess) {
            await this.launchedProcess.kill();
        }
	}

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.session.stepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.session.stepOut();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.session.stepOver();
		this.sendResponse(response);
	}

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.session.continue();
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// TODO: multithread support
		response.body = {
			threads: [
				new Thread(1, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const frames = await this.session.getStackFrames();
		const framesSlice = frames.slice(startFrame, endFrame);

		response.body = {
			stackFrames: framesSlice.map((f, ix) => {
				const sf: DebugProtocol.StackFrame = new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line));
				if (typeof f.column === 'number') {
					sf.column = this.convertDebuggerColumnToClient(f.column);
				}
				if (typeof f.instruction === 'number') {
					const address = this.formatAddress(f.instruction);
					sf.name = `${f.name} ${address}`; 
					sf.instructionPointerReference = address;
				}

				return sf;
			}),
			//no totalFrames: 				// VS Code has to probe/guess. Should result in a max. of two requests
			totalFrames: frames.length			// stk.count is the correct size, should result in a max. of two requests
			//totalFrames: 1000000 			// not the correct size, should result in a max. of two requests
			//totalFrames: endFrame + 20 	// dynamically increases the size with every requested chunk, results in paging
		};
		this.sendResponse(response);
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		this.session.setFocusedFrame(args.frameId);

		response.body = {
			scopes: [
				new Scope("Locals", this._variableHandles.create('locals'), true),
				new Scope("Globals", this._variableHandles.create('globals'), true),
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

		let vs: Variable[] = [];
		
		const v = this._variableHandles.get(args.variablesReference);
		
		if (v === 'locals') {
			vs = await this.session.listVariable(1000);
		} else if (v === 'globals') {
			vs = await this.session.listGlobalVariable(1001);
		} else if (args.variablesReference < 20000) {
			vs = await this.session.listVariable(args.variablesReference);
		} else if (args.variablesReference < 30000) {
			vs = await this.session.listGlobalVariable(args.variablesReference);
		}

		const variablesPromise = vs.map(async x => {
			const value = await this.session.dumpVariable(x.name) || '???';

			return {
				name: x.name,
				type: x.type,
				value,
				variablesReference: x.childGroupId || 0
			};
		}).map((x, i) => x.catch(e => { 
			return {
				name: vs[i].name,
				type: 'evaluation failed!',
				value: e.message ? e.message : 'unknown',
				variablesReference: 0
			}	
		}));

		const variables: DebugProtocol.Variable[] = await Promise.all(variablesPromise);

		response.body = {
			variables
		};
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {

		const value = await this.session.dumpVariable(args.expression) || '???';
	
		response.body = {
			result: value,
			variablesReference: 0
		};

		this.sendResponse(response);
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}

	private formatAddress(x: number, pad = 8) {
		return '0x' + x.toString(16).padStart(pad, '0');
	}
}