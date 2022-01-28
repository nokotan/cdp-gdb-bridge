import * as vscode from 'vscode';
import { ILaunchRequestArguments, VSCodeDebugSession } from './dapServer'
import { CancellationToken, DebugConfiguration, DebugConfigurationProvider, ProviderResult, WorkspaceFolder } from 'vscode';

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new VSCodeDebugSession(vscode.debug.activeDebugConsole));
	}

	dispose() {
		
	}
}

type WebAssemblyDebugConfiguration = ILaunchRequestArguments & DebugConfiguration;

class WebAssemblyChromeConfigurationProvider implements DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: WebAssemblyDebugConfiguration, token?: CancellationToken) {

		if (!config.url) {
			await vscode.window.showInformationMessage("Cannot find a url to debug");
			return undefined;
		}

		return config;
	}
}

class WebAssemblyNodeConfigurationProvider implements DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: WebAssemblyDebugConfiguration, token?: CancellationToken) {

		if (!config.program) {
			await vscode.window.showInformationMessage("Cannot find a program to debug");
			return undefined;
		}

		return config;
	}
}

export function activate(context: vscode.ExtensionContext) {

	// register a configuration provider for 'wasm' debug type
	{
		const provider = new WebAssemblyChromeConfigurationProvider();
		context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('wasm-chrome', provider));
	}

	{
		const provider = new WebAssemblyNodeConfigurationProvider();
		context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('wasm-node', provider));
	}

	const factory = new InlineDebugAdapterFactory();

	for (const type of [ 'wasm-chrome', 'wasm-node' ]) {
		context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(type, factory));
	}
}

export function deactivate() {
    
}