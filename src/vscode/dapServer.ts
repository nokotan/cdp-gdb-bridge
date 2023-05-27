import { DebugProtocol } from '@vscode/debugprotocol';
import {
	LoggingDebugSession,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, TerminatedEvent,
	InitializedEvent,
	OutputEvent
} from '@vscode/debugadapter';
import { launch } from 'chrome-launcher';
import CDP from 'chrome-remote-interface';
import { DebugSession } from '../core/DebugSession'
import { Variable } from '../core/DebugCommand';
import { DebugAdapter } from '../core/DebugAdapterInterface';
import { basename } from 'path'
import { ChildProcess, spawn } from 'child_process';
import { createConnection } from 'net';
import fetch from 'node-fetch-commonjs';

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

	flags?: string[];
}

interface INodeLaunchRequestArguments {
	type: 'wasm-node';
	
	/** An absolute url to the "program" to debug. */
	program?: string;

	port?: number;

	/** An absolute url to the "program" to debug. */
	node?: string;

	cwd?: string;
}

export interface Logger {
	append(text: string): void;
	appendLine(text: string): void;
}

export type ILaunchRequestArguments = IChromeLaunchRequestArguments | INodeLaunchRequestArguments;

type LaunchRequestArgument = ILaunchRequestArguments & DebugProtocol.LaunchRequestArguments;



export class VSCodeDebugSession extends LoggingDebugSession implements DebugAdapter {

    private session: DebugSession;

	private client?: CDP.Client;

    private launchedProcess?: ChildProcess;

	private logger?: Logger; 

	private _variableHandles = new Handles<'locals' | 'globals'>();

    constructor(logger?: Logger) {
        super();

		this.session = new DebugSession(this);
		this.logger = logger;
    }

	private async terminate() {
		if (this.client) {
            console.error('Session Closed.');
            await this.client.close();

			this.client = undefined;
        }

        if (this.launchedProcess) {
			console.error('Process Closed.');
            this.launchedProcess.kill();

			this.launchedProcess = undefined;
        }
	} 

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

        // build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsTerminateRequest = true;

		this.session = new DebugSession(this);

        this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
    }

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: LaunchRequestArgument) {
		// connect to endpoint
		this.client = await CDP({
            port: args.port
        });

        // extract domains
        const { Debugger, Page, Runtime, Target, Console } = this.client;

		this.session.setChromeDebuggerApi(Debugger, Page, Runtime, Target);

		await Console.enable();
		Console.on("messageAdded", e => {
			if (e.message.level == "error") {
				this.sendEvent(new OutputEvent(e.message.text + "\n", 'stderr'));
			} else {
				this.sendEvent(new OutputEvent(e.message.text + "\n", 'stdout'));
			}
		});

		await this.session.activate();

		// nodejs don't have Page interface.
        if (Page) await Page.enable();		

		this.sendResponse(response);
	}

	private async waitForInspectableTarget(port: number) {
		function checkPort() {
			return new Promise<boolean>(resolve => {
				const client = createConnection(port);
				client.once('error', _ => {
					client.removeAllListeners();
					client.end();
					client.destroy();
					client.unref();
					resolve(false);
				});
				client.once('connect', () => {
					client.removeAllListeners();
					client.end();
					client.destroy();
					client.unref();
					resolve(true);
				});
			});
		}

		async function checkEndpoint() {
			// https://github.com/bbc/a11y-tests-web/pull/62
			const rawResponse = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = await rawResponse.json() as unknown[];
			return targets.length > 0;
		}

		function sleep(milliSecond: number) {
			return new Promise<void>((resolve, _) => {
				setTimeout(resolve, milliSecond)
			});
		}

		let attempt = 0;

		while (!await checkPort()) {
			await sleep(500);
			
			if (attempt++ > 10) {
				throw new Error("Target port timeout");
			}
		}

		attempt = 0;
		
		while (!await checkEndpoint()) {
			await sleep(500);
			
			if (attempt++ > 10) {
				throw new Error("Target port timeout");
			}
		}
	}

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArgument) {
		const port = args.port || 9222;

		switch (args.type) {
			case 'wasm-chrome': {
				const launchedProcess = await launch({
					port: port,
					chromeFlags: args.flags
				});

				this.launchedProcess = launchedProcess.process;
				break;
			}	
			case 'wasm-node': {
				const nodeExecitable = args.node || "node";
				const launchedProcess = spawn(nodeExecitable, [ `--inspect-brk=${port}`, args.program! ], { cwd: args.cwd });
				let textBuffer = "";

				launchedProcess.stderr?.on('data', (d: Buffer) => { 
					textBuffer += d.toString();

					const splitText = textBuffer.split("\n");

					while (splitText.length > 1) {
						const text = splitText.shift() || "";

						// FIXME
						if (text.trim() === "Waiting for the debugger to disconnect...") {
							void this.terminate();
						}
					}

					textBuffer = splitText[0];
				});

				this.launchedProcess = launchedProcess;
				break;
			}		
		}		

		await this.waitForInspectableTarget(port);

        // connect to endpoint
		const client = await CDP({
            port
        });
		this.client = client;

		console.error("Session Opened.");

		this.launchedProcess?.on('exit', () => { 
			console.error("Process terminated");
			this.sendEvent(new TerminatedEvent());
		});

        // extract domains
        const { Debugger, Page, Runtime, Target, Console } = this.client;

		this.session.setChromeDebuggerApi(Debugger, Page, Runtime, Target);

		await Console.enable();
		Console.on("messageAdded", e => {
			if (e.message.level == "error") {
				this.sendEvent(new OutputEvent(e.message.text + "\n", 'stderr'));
			} else {
				this.sendEvent(new OutputEvent(e.message.text + "\n", 'stdout'));
			}
		});

		await this.session.activate();
		
		// nodejs don't have Page interface.
        if (Page && args.type == "wasm-chrome") {
			await Page.enable();
			await Page.navigate({ url: args.url || "index.html" });
		}

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

		const path = (args.source.path as string).replace(/\\/g, "/");
		const clientLines = args.lines || [];

		console.error("setBreakPoint");

		await this.session.removeAllBreakPoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints0 = clientLines.map(async l => {
			const fileSpec = {
				file: path,
				line: l
			};
			return await this.session.setBreakPoint(fileSpec);
		});
		const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);
		console.error(actualBreakpoints);

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

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request) {
		this.sendResponse(response);
	}

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
		await this.session.stepIn(args.threadId);
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) {
		await this.session.stepOut(args.threadId);
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
		await this.session.stepOver(args.threadId);
		this.sendResponse(response);
	}

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		await this.session.continue(args.threadId);
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		const threads = this.session.getThreadList();

		response.body = {
			threads: threads.map(x => new Thread(x.threadID, x.threadName))
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const frames = await this.session.getStackFrames(args.threadId);
		const framesSlice = frames.slice(startFrame, endFrame);

		this.session.setFocusedThread(args.threadId);

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
				sf.source = { path: f.file };

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
		await this.session.setFocusedFrame(args.frameId);

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
			const value = await this.session.dumpVariable(x.displayName) || '???';

			return {
				name: x.name,
				type: x.type,
				value,
				variablesReference: x.childGroupId || 0
			};
		}).map((x, i) => x.catch((e: Error) => { 
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

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
		console.error("terminate Request");
		await this.terminate();
		this.sendResponse(response);
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}

	private formatAddress(x: number, pad = 8) {
		return '0x' + x.toString(16).padStart(pad, '0');
	}
}