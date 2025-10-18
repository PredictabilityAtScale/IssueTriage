import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { SettingsService } from './settingsService';
import { StateService } from './stateService';
import { TelemetryService } from './telemetryService';

export type CliToolOutputType = 'text' | 'json';

type CliToolSource = 'builtin' | 'user';

type RunnableCliTool = CliToolDescriptor & { command: string; args: string[] };

export interface CliToolDescriptor {
	id: string;
	title: string;
	description?: string;
	command: string;
	args: string[];
	enabled: boolean;
	autoRun?: boolean;
	refreshIntervalMs?: number;
	outputType: CliToolOutputType;
	timeoutMs?: number;
	cwd?: string;
	shell?: boolean;
	env?: Record<string, string>;
	source: CliToolSource;
}

export interface CliToolRunResult {
	id: string;
	title: string;
	command: string;
	args: string[];
	stdout: string;
	stderr: string;
	parsedJson?: unknown;
	parseError?: string;
	outputType: CliToolOutputType;
	exitCode: number | null;
	success: boolean;
	truncated: boolean;
	timedOut?: boolean;
	runAt: string;
	durationMs: number;
	source: CliToolSource;
}

interface PersistedCliResult {
	id: string;
	title: string;
	command: string;
	args: string[];
	stdout: string;
	stderr: string;
	outputType: CliToolOutputType;
	exitCode: number | null;
	success: boolean;
	truncated: boolean;
	timedOut?: boolean;
	runAt: string;
	durationMs: number;
	source: CliToolSource;
	parsedJson?: unknown;
	parseError?: string;
}

interface UserConfiguredCliTool {
	id?: string;
	title?: string;
	description?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	enabled?: boolean;
	autoRun?: boolean;
	refreshIntervalMs?: number;
	timeoutMs?: number;
	shell?: boolean;
	outputType?: CliToolOutputType;
}

interface RunToolOptions {
	reason?: 'manual' | 'auto';
	force?: boolean;
}

const RESULT_STATE_KEY = 'cliToolResults';
const DEFAULT_TIMEOUT_MS = 120 * 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_STDOUT_CHARS = 20000;
const MAX_STDERR_CHARS = 5000;

const BUILTIN_WORKSPACE_SCRIPT = String.raw`
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.env.ISSUETRIAGE_WORKSPACE_ROOT || process.cwd();
const summary = {
  generatedAt: new Date().toISOString(),
  workspace: {
    root,
    name: path.basename(root)
  },
  git: {},
  packageJson: undefined,
  notes: []
};

try {
  const status = execSync('git status --short', { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  summary.git.status = status.trim();
} catch (error) {
  summary.git.error = error?.message || String(error);
  summary.notes.push('git status unavailable');
}

try {
  const recent = execSync('git log -5 --pretty=format:%h:::%an:::%ar:::%s', { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  summary.git.recentCommits = recent.trim().split('\n').filter(Boolean).map(line => {
    const [hash, author, when, message] = line.split(':::');
    return { hash, author, when, message };
  });
} catch (error) {
  summary.notes.push('recent commits unavailable');
}

try {
  const packageJsonPath = path.join(root, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const content = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(content);
    summary.packageJson = {
      name: pkg.name,
      version: pkg.version,
      scripts: Object.keys(pkg.scripts || {}),
      dependencies: Object.keys(pkg.dependencies || {}),
      devDependencies: Object.keys(pkg.devDependencies || {})
    };
  }
} catch (error) {
  summary.notes.push('package.json parse failed');
}

console.log(JSON.stringify(summary, null, 2));
`;

const BUILTIN_TOOL_DEFINITIONS: ReadonlyArray<Omit<CliToolDescriptor, 'enabled' | 'command' | 'args'>> = [
	{
		id: 'builtin.workspaceSnapshot',
		title: 'Workspace Snapshot',
		description: 'Collects git status, recent commits, and package.json metadata for the workspace.',
		env: {
			ISSUETRIAGE_WORKSPACE_ROOT: '${workspaceRoot}'
		},
		autoRun: true,
		refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
		timeoutMs: 60 * 1000,
		outputType: 'json',
		shell: false,
		source: 'builtin'
	}
];

export class CliToolService implements vscode.Disposable {
	private readonly output: vscode.OutputChannel;
	private readonly results = new Map<string, CliToolRunResult>();
	private readonly descriptors = new Map<string, RunnableCliTool>();
	private readonly disabledToolIds = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly pendingRuns = new Map<string, Promise<CliToolRunResult>>();
	private disposed = false;

	public constructor(
		private readonly extensionRoot: string,
		private readonly settings: SettingsService,
		private readonly state: StateService,
		private readonly telemetry: TelemetryService,
		outputChannel?: vscode.OutputChannel
	) {
		this.output = outputChannel ?? vscode.window.createOutputChannel('IssueTriage CLI Context');

		this.restoreResults();
		this.reloadDescriptors();

		const configurationSubscription = vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('issuetriage.cliTools')) {
				this.reloadDescriptors();
			}
		});
		this.disposables.push(configurationSubscription, this.output);
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.pendingRuns.clear();
		this.disposables.forEach(disposable => disposable.dispose());
	}

	public listTools(): CliToolDescriptor[] {
		return Array.from(this.descriptors.values())
			.map(descriptor => ({ ...descriptor }))
			.sort((a, b) => a.title.localeCompare(b.title));
	}

	public showOutput(): void {
		this.output.show(true);
	}

	public getResult(id: string): CliToolRunResult | undefined {
		return this.results.get(id);
	}

	public async ensureAutoRunResults(): Promise<void> {
		const now = Date.now();
		const tools = Array.from(this.descriptors.values()).filter(tool => tool.enabled && tool.autoRun);
		for (const tool of tools) {
			const existing = this.results.get(tool.id);
			const lastRun = existing ? new Date(existing.runAt).getTime() : 0;
			const stale = !existing || (tool.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS) <= now - lastRun || !existing.success;
			if (stale) {
				try {
					await this.runTool(tool.id, { reason: 'auto', force: true });
				} catch (error) {
					this.output.appendLine(`[IssueTriage] Auto-run failed for ${tool.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}

	public async runTool(id: string, options: RunToolOptions = {}): Promise<CliToolRunResult> {
		const descriptor = this.descriptors.get(id);
		if (!descriptor) {
			throw new Error(`CLI tool ${id} is not registered.`);
		}
		if (!descriptor.enabled) {
			throw new Error(`CLI tool ${id} is disabled.`);
		}

		if (!options.force) {
			const existing = this.pendingRuns.get(id);
			if (existing) {
				return existing;
			}
		}

		const runPromise = this.executeTool(descriptor, options).finally(() => {
			this.pendingRuns.delete(id);
		});
		this.pendingRuns.set(id, runPromise);
		return runPromise;
	}

	public getPromptContext(maxChars = 6000): string | undefined {
		if (this.results.size === 0) {
			return undefined;
		}

		// Sort by most recent run
		const sorted = Array.from(this.results.values()).sort((a, b) => b.runAt.localeCompare(a.runAt));
		const lines: string[] = [];
		let length = 0;

		const append = (value: string) => {
			if (!value) {
				return;
			}
			if (length + value.length > maxChars) {
				const remaining = maxChars - length;
				if (remaining <= 0) {
					return;
				}
				lines.push(value.slice(0, remaining));
				length = maxChars;
				return;
			}
			lines.push(value);
			length += value.length;
		};

		append('CLI tool context (most recent runs):\n');
		for (const result of sorted) {
			append(`- ${result.title} [${result.id}] - ${result.success ? 'success' : 'failed'} at ${result.runAt}, exit ${result.exitCode ?? 'n/a'}, duration ${result.durationMs}ms\n`);
			if (result.stderr) {
				append(`  stderr: ${result.stderr}\n`);
			}
			if (result.outputType === 'json' && result.parsedJson && length < maxChars) {
				const json = JSON.stringify(result.parsedJson, null, 2);
				append(`  output (json): ${json}\n`);
			} else if (result.stdout) {
				append(`  output: ${result.stdout}\n`);
			}
			if (length >= maxChars) {
				append('\n...[truncated CLI context]\n');
				break;
			}
		}

		return lines.join('');
	}

	private async executeTool(descriptor: RunnableCliTool, options: RunToolOptions): Promise<CliToolRunResult> {
		const start = Date.now();
		const workspaceRoot = this.getWorkspaceRoot();
		const command = this.replaceTokens(descriptor.command, workspaceRoot);
		const args = descriptor.args.map(arg => this.replaceTokens(arg, workspaceRoot));
		const env = this.buildEnvironment(descriptor.env, workspaceRoot);
		const cwd = this.resolveCwd(descriptor.cwd, workspaceRoot);
		const timeoutMs = descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		this.output.appendLine(`[IssueTriage] Running CLI tool ${descriptor.id} (${descriptor.title})`);

		return new Promise<CliToolRunResult>((resolve, reject) => {
			let stdout = '';
			let stderr = '';
			let stdoutTruncated = false;
			let stderrTruncated = false;
			let timedOut = false;

			let timer: NodeJS.Timeout | undefined;

			const child = spawn(command, args, {
				cwd,
				env,
				shell: descriptor.shell ?? false,
				windowsHide: true
			});

			const clearTimer = () => {
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
			};

			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					try {
						child.kill();
					} catch (error) {
						this.output.appendLine(`[IssueTriage] Failed to terminate ${descriptor.id} after timeout: ${error instanceof Error ? error.message : String(error)}`);
					}
				}, timeoutMs);
			}

			child.stdout?.on('data', chunk => {
				const text = chunk.toString('utf8');
				const remaining = MAX_STDOUT_CHARS - stdout.length;
				if (remaining <= 0) {
					stdoutTruncated = true;
					return;
				}
				if (text.length > remaining) {
					stdout += text.slice(0, remaining);
					stdoutTruncated = true;
				} else {
					stdout += text;
				}
			});

			child.stderr?.on('data', chunk => {
				const text = chunk.toString('utf8');
				const remaining = MAX_STDERR_CHARS - stderr.length;
				if (remaining <= 0) {
					stderrTruncated = true;
					return;
				}
				if (text.length > remaining) {
					stderr += text.slice(0, remaining);
					stderrTruncated = true;
				} else {
					stderr += text;
				}
			});

			child.on('error', error => {
				clearTimer();
				reject(error);
			});

			child.on('close', code => {
				clearTimer();
				const duration = Date.now() - start;
				const cleanedStdout = stdout.replace(/\r\n/g, '\n').trim();
				const cleanedStderr = stderr.replace(/\r\n/g, '\n').trim();

				const result: CliToolRunResult = {
					id: descriptor.id,
					title: descriptor.title,
					command,
					args,
					stdout: cleanedStdout,
					stderr: cleanedStderr,
					outputType: descriptor.outputType,
					exitCode: timedOut ? null : code,
					success: !timedOut && code === 0,
					truncated: stdoutTruncated || stderrTruncated,
					timedOut,
					runAt: new Date().toISOString(),
					durationMs: duration,
					source: descriptor.source
				};

				if (descriptor.outputType === 'json' && cleanedStdout) {
					try {
						result.parsedJson = JSON.parse(cleanedStdout);
					} catch (error) {
						result.parseError = error instanceof Error ? error.message : String(error);
						result.success = false;
					}
				}

				this.results.set(descriptor.id, result);
				this.persistResults().catch(persistError => {
					this.output.appendLine(`[IssueTriage] Failed to persist CLI results: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
				});

				this.telemetry.trackEvent('cliTool.run', {
					id: descriptor.id,
					reason: options.reason ?? 'manual',
					source: descriptor.source,
					success: result.success ? 'true' : 'false'
				}, {
					durationMs: result.durationMs
				});

				this.output.appendLine(`[IssueTriage] CLI tool ${descriptor.id} completed in ${duration}ms (exit ${result.exitCode ?? 'n/a'})`);
				if (cleanedStderr) {
					this.output.appendLine(`[IssueTriage] stderr: ${cleanedStderr}`);
				}

				resolve(result);
			});
		});
	}

	private restoreResults(): void {
		const persisted = this.state.getWorkspace<PersistedCliResult[]>(RESULT_STATE_KEY, []);
		if (!persisted) {
			return;
		}
		for (const item of persisted) {
			this.results.set(item.id, { ...item });
		}
	}

	private async persistResults(): Promise<void> {
		const serialized = Array.from(this.results.values()).map(result => ({
			id: result.id,
			title: result.title,
			command: result.command,
			args: result.args,
			stdout: result.stdout,
			stderr: result.stderr,
			outputType: result.outputType,
			exitCode: result.exitCode,
			success: result.success,
			truncated: result.truncated,
			timedOut: result.timedOut,
			runAt: result.runAt,
			durationMs: result.durationMs,
			source: result.source,
			parsedJson: result.parsedJson,
			parseError: result.parseError
		} satisfies PersistedCliResult));
		await this.state.updateWorkspace(RESULT_STATE_KEY, serialized);
	}

	private reloadDescriptors(): void {
		this.descriptors.clear();
		this.disabledToolIds.clear();

		const builtins = this.buildBuiltinDescriptors();
		for (const descriptor of builtins) {
			this.descriptors.set(descriptor.id, descriptor);
		}

		const userDescriptors = this.buildUserDescriptors();
		for (const descriptor of userDescriptors) {
			if (!descriptor.enabled) {
				this.descriptors.delete(descriptor.id);
				this.disabledToolIds.add(descriptor.id);
				continue;
			}
			this.descriptors.set(descriptor.id, descriptor);
		}
	}

	private buildBuiltinDescriptors(): RunnableCliTool[] {
		const workspaceRoot = this.getWorkspaceRoot();
		return BUILTIN_TOOL_DEFINITIONS.map(definition => ({
			...definition,
			enabled: !this.disabledToolIds.has(definition.id),
			command: this.replaceTokens('${node}', workspaceRoot),
			args: ['-e', BUILTIN_WORKSPACE_SCRIPT]
		}));
	}

	private buildUserDescriptors(): RunnableCliTool[] {
		const configs = this.settings.get<UserConfiguredCliTool[]>('cliTools', []) ?? [];
		const workspaceRoot = this.getWorkspaceRoot();
		const descriptors: RunnableCliTool[] = [];
		for (const config of configs) {
			if (!config || typeof config !== 'object') {
				continue;
			}
			const id = this.normalizeId(config.id);
			if (!id) {
				continue;
			}

			if (config.enabled === false && !config.command) {
				// Disable existing tool with matching id
				this.disabledToolIds.add(id);
				const existing = this.descriptors.get(id);
				if (existing) {
					existing.enabled = false;
				}
				continue;
			}

			const command = this.replaceTokens(config.command ?? '', workspaceRoot);
			if (!command) {
				continue;
			}

			const args = Array.isArray(config.args) ? config.args.map(arg => this.replaceTokens(String(arg), workspaceRoot)) : [];
			const envOverrides = this.normalizeEnvConfig(config.env);
			const descriptor: RunnableCliTool = {
				id,
				title: config.title?.trim() || id,
				description: config.description?.trim(),
				command,
				args,
				enabled: config.enabled !== false,
				autoRun: config.autoRun ?? false,
				refreshIntervalMs: config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
				outputType: config.outputType ?? 'text',
				timeoutMs: config.timeoutMs,
				cwd: config.cwd ? this.replaceTokens(config.cwd, workspaceRoot) : undefined,
				shell: config.shell,
				env: envOverrides,
				source: 'user'
			};
			descriptors.push(descriptor);
		}
		return descriptors;
	}

	private normalizeEnvConfig(env: Record<string, unknown> | undefined): Record<string, string> | undefined {
		if (!env) {
			return undefined;
		}
		const normalized: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) {
			if (typeof value === 'string') {
				normalized[key] = value;
			}
		}
		return Object.keys(normalized).length ? normalized : undefined;
	}

	private normalizeId(id: string | undefined): string | undefined {
		if (!id) {
			return undefined;
		}
		const trimmed = id.trim();
		return trimmed ? trimmed : undefined;
	}

	private replaceTokens(value: string | undefined, workspaceRoot: string | undefined): string {
		if (!value) {
			return value ?? '';
		}
		let replaced = value.replace(/\$\{workspaceRoot\}|\$\{workspaceFolder\}/g, workspaceRoot ?? process.cwd());
		replaced = replaced.replace(/\$\{extensionRoot\}/g, this.extensionRoot);
		replaced = replaced.replace(/\$\{node\}/g, process.execPath);
		return replaced;
	}

	private buildEnvironment(env: Record<string, string> | undefined, workspaceRoot: string | undefined): NodeJS.ProcessEnv {
		const merged = { ...process.env };
		if (!env) {
			return merged;
		}
		for (const [key, value] of Object.entries(env)) {
			if (typeof value !== 'string') {
				continue;
			}
			merged[key] = this.replaceTokens(value, workspaceRoot);
		}
		return merged;
	}

	private resolveCwd(cwd: string | undefined, workspaceRoot: string | undefined): string | undefined {
		if (!cwd || !cwd.trim()) {
			return workspaceRoot ?? process.cwd();
		}
		return path.isAbsolute(cwd) ? cwd : (workspaceRoot ? path.join(workspaceRoot, cwd) : path.resolve(process.cwd(), cwd));
	}

	private getWorkspaceRoot(): string | undefined {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return undefined;
		}
		return folders[0]?.uri.fsPath;
	}
}
