import { DebugProtocol } from 'vscode-debugprotocol';
import {
	LoggingDebugSession,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, TerminatedEvent
} from 'vscode-debugadapter';
import { launch, LaunchedChrome } from 'chrome-launcher';
import CDP from 'chrome-remote-interface';
import { DebugSessionManager, Variable, DebuggerCommand } from '../core/DebugSession'
import { DebugAdapter } from '../core/DebugAdapterInterface';
import { basename } from 'path'

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	url: string;
}

export class VSCodeDebugSession extends LoggingDebugSession implements DebugAdapter {

    private session?: DebuggerCommand;

	private client?: CDP.Client;

    private launchedBrowser?: LaunchedChrome;

	private _variableHandles = new Handles<'locals' | 'globals'>();

    constructor() {
        super();
    }

	private onTerminated() {
		this.sendEvent(new TerminatedEvent());
		this.launchedBrowser = undefined;
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
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
		this.launchedBrowser = await launch({
        });

		this.launchedBrowser.process.on('exit', () => this.onTerminated());

        // connect to endpoint
        this.client = await CDP({
            port: this.launchedBrowser.port
        });

        // extract domains
        const { Debugger, Page, Runtime } = this.client;

        await Debugger.enable({});
        await Page.enable();
        await Runtime.enable();

        this.session = new DebugSessionManager(Debugger, Page, Runtime, this);
		this.session.jumpToPage(args.url);

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

		const path = args.source.path as string;
		const clientLines = args.lines || [];

		await this.session?.removeAllBreakPoints(path);

		// set and verify breakpoint locations
		const actualBreakpoints0 = clientLines.map(async l => {
			const fileSpec = `${path}:${l}`
			const { verified, line, id } = await this.session?.setBreakPoint(fileSpec)!;
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
			const bps = await this.session!.getBreakPointsList(`${args.source}:${args.line}`);
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
            console.log('session closed.');
            await this.client.close();
        }

        if (this.launchedBrowser) {
            await this.launchedBrowser.kill();
        }
	}

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.session?.stepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.session?.stepOut();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.session?.stepOver();
		this.sendResponse(response);
	}

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.session?.continue();
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
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

		const frames = await this.session!.getStackFrames();
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
		this.session!.setFocusedFrame(args.frameId);

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
			vs = await this.session!.listVariable();
		} else if (v === 'globals') {
			vs = await this.session!.listGlobalVariable();
		}

		const variablesPromise = vs.map(async x => {
			const value = await this.session!.dumpVariable(x.name) || '???';

			return {
				name: x.name,
				type: x.type,
				value,
				variablesReference: 0
			};
		});

		const variables: DebugProtocol.Variable[] = await Promise.all(variablesPromise);

		response.body = {
			variables
		};
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {

		const locals: Variable[] = await this.session!.listVariable();
		const globals: Variable[] = await this.session!.listGlobalVariable();
		const vs = locals.concat(globals);

		const variablesPromise = vs
			.filter(x => x.name == args.expression)
			.map(async x => {
				const value = await this.session!.dumpVariable(x.name) || '???';

				return {
					name: x.name,
					type: x.type,
					value,
					variablesReference: 0
				};
			});

		const variables: DebugProtocol.Variable[] = await Promise.all(variablesPromise);

		if (variables.length > 0) {
			response.body = {
				result: variables[0].value,
				type: variables[0].type,
				variablesReference: variables[0].variablesReference
			};
		} 

		this.sendResponse(response);
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}

	private formatAddress(x: number, pad = 8) {
		return '0x' + x.toString(16).padStart(8, '0');
	}
}