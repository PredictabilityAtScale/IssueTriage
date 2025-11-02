import * as vscode from 'vscode';
import type {
	RequestedEntitlements,
	WithUsageContext,
	WithUsageOptions,
	EndCallRequest,
	UsageTapClientOptions
} from '@usagetap/sdk' with { "resolution-mode": "import" };
import type { SettingsService } from './settingsService';
import type { TelemetryService } from './telemetryService';

export interface UsageTapCallOptions {
	feature: string;
	tags?: string[];
	requested?: RequestedEntitlements;
	customerName?: string;
	customerEmail?: string;
	stripeCustomerId?: string;
	idempotency?: string;
	withUsageOptions?: WithUsageOptions;
}

export interface UsageTapOperationHooks {
	setUsage(usage: UsageTapUsagePayload): void;
	setError(code: string, message: string): void;
}

export type UsageTapHandler<T> = (hooks: UsageTapOperationHooks) => Promise<T>;

export type UsageTapUsagePayload = Partial<Omit<EndCallRequest, 'callId' | 'error'>>;

type UsageTapModule = {
	UsageTapClient: new (options: UsageTapClientOptions) => UsageTapClient;
};

type UsageTapClient = {
	createCustomer(request: { customerId: string; customerFriendlyName?: string; customerEmail?: string; stripeCustomerId?: string }): Promise<unknown>;
	withUsage<T>(beginRequest: unknown, handler: (context: WithUsageContext) => Promise<T>, options?: WithUsageOptions): Promise<T>;
};

export interface UsageTapServiceOverrides {
	customerId?: string;
	clientFactory?: () => UsageTapClient;
}

const USAGETAP_EMBEDDED_KEY = 'ek-btNBcPLtj7iGrTduOP4I6bxbJhEWXMaNkpJBNfVIYuM';
const USAGETAP_BASE_URL = 'https://api.usagetap.com/';
const DEFAULT_TAGS = ['issuetriage', 'vscode-extension'];

export class UsageTapService implements vscode.Disposable {
	private readonly overrides: UsageTapServiceOverrides;
	private readonly telemetry: TelemetryService;
	private readonly settings: SettingsService;
	private readonly customerId: string;
	private readonly debugEnabled: boolean;
	private readonly debugChannel?: vscode.OutputChannel;
	private clientPromise?: Promise<UsageTapClient | null>;
	private customerProvisionPromise?: Promise<boolean>;
	private customerProvisioned = false;
	private disposed = false;
	private static modulePromise?: Promise<UsageTapModule>;
	public constructor(settings: SettingsService, telemetry: TelemetryService, overrides: UsageTapServiceOverrides = {}) {
		this.settings = settings;
		this.telemetry = telemetry;
		this.overrides = overrides;
		this.customerId = overrides.customerId ?? UsageTapService.resolveCustomerId();

		const debugEnv = process.env.ISSUETRIAGE_USAGETAP_DEBUG;
		const envExplicit = typeof debugEnv === 'string';
		const envValue = debugEnv?.toLowerCase?.();
		const envEnabled = envExplicit && debugEnv !== '0' && envValue !== 'false' && envValue !== 'off';
		const settingEnabled = this.settings.get<boolean>('telemetry.usagetapDebug') === true;
		this.debugEnabled = envExplicit ? envEnabled : settingEnabled;
		if (this.debugEnabled) {
			this.debugChannel = vscode.window.createOutputChannel('IssueTriage UsageTap');
			this.debug('UsageTap debug logging enabled', { customerId: this.customerId });
		}
	}

	public dispose(): void {
		this.disposed = true;
		this.clientPromise = undefined;
		this.customerProvisionPromise = undefined;
		this.debug('UsageTap service disposed');
		this.debugChannel?.dispose();
	}

	public getCustomerId(): string {
		return this.customerId;
	}

	public async ensureCustomerProvisioned(): Promise<boolean> {
		if (!this.isEnabled() || this.disposed) {
			this.debug('ensureCustomerProvisioned skipped', { enabled: this.isEnabled(), disposed: this.disposed });
			return false;
		}

		if (this.customerProvisioned) {
			return true;
		}

		const skipProvisioning = process.env.ISSUETRIAGE_USAGETAP_SKIP_PROVISION === 'true';
		if (skipProvisioning) {
			this.debug('ensureCustomerProvisioned skipping (SKIP_PROVISION=true)');
			return true;
		}

		const client = await this.ensureClient();
		if (!client) {
			return false;
		}

		return this.ensureCustomer(client);
	}

	public async runWithUsage<T>(options: UsageTapCallOptions, handler: UsageTapHandler<T>): Promise<T> {
		if (!this.isEnabled() || this.disposed) {
			this.debug('runWithUsage skipped', {
				feature: options.feature,
				disposed: this.disposed,
				enabled: this.isEnabled()
			});
			return handler(UsageTapService.noopHooks);
		}

		this.debug('runWithUsage invoked', {
			feature: options.feature,
			customerId: this.customerId,
			tags: options.tags
		});

		const client = await this.ensureClient();
		if (!client) {
			this.debug('runWithUsage aborted: no client available', { feature: options.feature });
			return handler(UsageTapService.noopHooks);
		}

		const skipProvisioning = process.env.ISSUETRIAGE_USAGETAP_SKIP_PROVISION === 'true';
		if (!skipProvisioning) {
			const customerReady = await this.ensureCustomer(client);
			if (!customerReady) {
				this.debug('runWithUsage aborted: customer provisioning failed', { feature: options.feature });
				return handler(UsageTapService.noopHooks);
			}
		} else {
			this.debug('runWithUsage skipping customer provisioning (SKIP_PROVISION=true)');
		}

		const beginRequest = {
			customerId: this.customerId,
			feature: options.feature,
			tags: this.mergeTags(options.tags),
			requested: options.requested,
			customerName: options.customerName,
			customerEmail: options.customerEmail,
			stripeCustomerId: options.stripeCustomerId,
			idempotency: options.idempotency ?? UsageTapService.generateIdempotencyKey()
		};

		this.debug('runWithUsage starting UsageTap call', { feature: options.feature, tags: beginRequest.tags, idempotency: beginRequest.idempotency });
		return client.withUsage(beginRequest, async (context: WithUsageContext) => {
			let errorCaptured = false;
			const hooks: UsageTapOperationHooks = {
				setUsage: usage => {
					this.debug('UsageTap hooks.setUsage invoked', usage);
					context.setUsage(usage);
				},
				setError: (code, message) => {
					errorCaptured = true;
					this.debug('UsageTap hooks.setError invoked', { code, message });
					context.setError({ code, message });
				}
			};

			try {
				this.debug('Executing wrapped handler', { feature: options.feature });
				const result = await handler(hooks);
				this.debug('Wrapped handler completed', { feature: options.feature });
				return result;
			} catch (error) {
				if (!errorCaptured) {
					const message = error instanceof Error ? error.message : String(error);
					this.debug('Wrapped handler threw before UsageTap error was set', { feature: options.feature, message });
					context.setError({ code: 'VENDOR_ERROR', message });
				}
				this.debug('Wrapped handler re-throwing error', { feature: options.feature, error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}, options.withUsageOptions);
	}

	public resolveRequestedEntitlements(model: string, extras?: Partial<RequestedEntitlements>): RequestedEntitlements | undefined {
		const normalized = model.trim().toLowerCase();
		const requested: RequestedEntitlements = { standard: true };
		if (normalized.includes('gpt-5') && !normalized.includes('mini')) {
			requested.premium = true;
		}
		if (extras) {
			return { ...requested, ...extras };
		}
		return requested;
	}

	public extractUsageFromOpenAIResponse(payload: unknown, fallbackModel?: string): UsageTapUsagePayload | undefined {
		if (!payload || typeof payload !== 'object') {
			return undefined;
		}
		const record = payload as { usage?: Record<string, unknown>; model?: unknown };
		const usageNode = record.usage;
		if (!usageNode || typeof usageNode !== 'object') {
			return undefined;
		}

		const usageRecord = usageNode as Record<string, unknown>;
		const usagePayload: UsageTapUsagePayload = {};

		const promptTokens = UsageTapService.readNumber(usageRecord['prompt_tokens'] ?? usageRecord['input_tokens']);
		if (promptTokens !== undefined) {
			usagePayload.inputTokens = promptTokens;
		}

		const completionTokens = UsageTapService.readNumber(usageRecord['completion_tokens'] ?? usageRecord['output_tokens'] ?? usageRecord['response_tokens']);
		if (completionTokens !== undefined) {
			usagePayload.responseTokens = completionTokens;
		}

		const cachedTokens = UsageTapService.readNumber(usageRecord['cached_tokens'] ?? usageRecord['prompt_cache_hit_tokens'] ?? usageRecord['input_cache_tokens']);
		if (cachedTokens !== undefined) {
			usagePayload.cachedTokens = cachedTokens;
		}

		const reasoningTokens = UsageTapService.readNumber(usageRecord['reasoning_tokens']);
		if (reasoningTokens !== undefined) {
			usagePayload.reasoningTokens = reasoningTokens;
		}

		const searches = UsageTapService.readNumber(usageRecord['web_search_queries'] ?? usageRecord['searches']);
		if (searches !== undefined) {
			usagePayload.searches = searches;
		}

		const modelUsed = typeof record.model === 'string' && record.model.trim().length > 0 ? record.model.trim() : fallbackModel;
		if (modelUsed) {
			usagePayload.modelUsed = modelUsed;
		}

		return Object.keys(usagePayload).length > 0 ? usagePayload : undefined;
	}

	private async ensureClient(): Promise<UsageTapClient | null> {
		if (this.clientPromise) {
			this.debug('ensureClient returning cached client');
			return this.clientPromise;
		}

		const creation = (async () => {
			this.debug('ensureClient starting client creation');
			const apiKey = USAGETAP_EMBEDDED_KEY;
			if (!apiKey || apiKey.trim().length === 0) {
				this.debug('ensureClient aborted: missing embedded API key');
				return null;
			}
			const baseUrl = USAGETAP_BASE_URL;
			const defaultTags = DEFAULT_TAGS;
			const configDebug = {
				baseUrl,
				apiKeyLength: apiKey.length,
				apiKeyPreview: `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
				defaultTags
			};
			this.debug('ensureClient resolved configuration', configDebug);

			try {
				const client = this.overrides.clientFactory
					? this.overrides.clientFactory()
					: await UsageTapService.createClient({
						apiKey,
						baseUrl,
						defaultFeature: 'issuetriage.call',
						defaultTags,
						useApiKeyHeader: true,
						onLog: this.debugEnabled ? (entry) => {
							this.debug('SDK Log', entry as unknown as Record<string, unknown>);
						} : undefined
					});
				this.debug('UsageTap client created successfully');
				return client;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.debug('UsageTap client creation failed', UsageTapService.serializeError('clientCreation', error));
				this.telemetry.trackEvent('usagetap.initializeFailed', { message });
				return null;
			}
		})();

		this.clientPromise = creation
			.then(client => {
				if (!client) {
					this.clientPromise = undefined;
				}
				return client;
			})
			.catch(() => {
				this.clientPromise = undefined;
				return null;
			});

		return this.clientPromise;
	}

	private async ensureCustomer(client: UsageTapClient): Promise<boolean> {
		if (this.customerProvisioned) {
			this.debug('ensureCustomer skipped: already provisioned');
			return true;
		}

		if (!this.customerProvisionPromise) {
			this.debug('ensureCustomer creating provision promise');
			const provision = (async () => {
				const customerPayload = {
					customerId: this.customerId,
					customerFriendlyName: UsageTapService.resolveFriendlyCustomerName()
				};
				this.debug('ensureCustomer sending request', customerPayload);
				
				try {
					const result = await client.createCustomer(customerPayload);
					this.debug('UsageTap customer ensured', { 
						customerId: this.customerId,
						result: typeof result === 'object' ? JSON.stringify(result) : String(result)
					});
					this.customerProvisioned = true;
					return true;
				} catch (error) {
					const serialized = UsageTapService.serializeError('createCustomer', error);
					this.debug('UsageTap customer provisioning failed', serialized);
					this.telemetry.trackEvent('usagetap.createCustomerFailed', { 
						message: error instanceof Error ? error.message : String(error),
						details: JSON.stringify(serialized)
					});
					return false;
				}
			})();

			this.customerProvisionPromise = provision
				.then(success => {
					if (!success) {
						this.customerProvisionPromise = undefined;
					}
					return success;
				})
				.catch(() => {
					this.customerProvisionPromise = undefined;
					return false;
				});
		}

		const success = await this.customerProvisionPromise;
		return success === true;
	}

	private isEnabled(): boolean {
		const telemetryPreference = this.settings.get<boolean>('telemetry.enabled');
		if (telemetryPreference === false) {
			return false;
		}
		if (telemetryPreference === true) {
			return true;
		}
		return vscode.env.isTelemetryEnabled;
	}

	private mergeTags(tags?: string[]): string[] | undefined {
		if (!tags || tags.length === 0) {
			return undefined;
		}
		return Array.from(new Set([...DEFAULT_TAGS, ...tags.filter(Boolean)]));
	}

	private static resolveCustomerId(): string {
		const machineId = vscode.env.machineId?.trim();
		return machineId && machineId.length > 0 ? machineId : 'unknown';
	}

	private static resolveFriendlyCustomerName(): string {
		const appName = vscode.env.appName?.trim();
		return appName && appName.length > 0 ? appName : 'VS Code';
	}

	private static readNumber(value: unknown): number | undefined {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		return undefined;
	}

	private static async loadModule(): Promise<UsageTapModule> {
		if (!UsageTapService.modulePromise) {
			UsageTapService.modulePromise = import('@usagetap/sdk').then(module => ({
				UsageTapClient: module.UsageTapClient
			}));
		}
		return UsageTapService.modulePromise;
	}

	private static async createClient(options: UsageTapClientOptions): Promise<UsageTapClient> {
		const module = await UsageTapService.loadModule();
		return new module.UsageTapClient(options) as UsageTapClient;
	}

	private static generateIdempotencyKey(): string {
		const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
		if (randomUUID) {
			return randomUUID();
		}
		const segment = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
		return `${Date.now().toString(16)}-${segment()}${segment()}`;
	}

	private static readonly noopHooks: UsageTapOperationHooks = {
		setUsage: () => {
			// no-op
		},
		setError: () => {
			// no-op
		}
	};

	private debug(message: string, data?: Record<string, unknown>): void {
		if (!this.debugEnabled) {
			return;
		}
		try {
			const timestamp = new Date().toISOString();
			const suffix = data ? ` ${JSON.stringify(data)}` : '';
			this.debugChannel?.appendLine(`${timestamp} ${message}${suffix}`);
		} catch (error) {
			// Swallow logging issues; we never want debug output to break execution.
			console.warn('[IssueTriage] Failed to write UsageTap debug log:', error);
		}
	}

	private static serializeError(context: string, error: unknown): Record<string, unknown> {
		if (!error) {
			return { context, message: 'Unknown error' };
		}
		if (error instanceof Error) {
			const shape: Record<string, unknown> = {
				context,
				name: error.name,
				message: error.message
			};
			const anyError = error as unknown as Record<string, unknown>;
			if (typeof anyError === 'object') {
				for (const key of ['status', 'code', 'retryable', 'correlationId', 'details']) {
					if (anyError && Object.prototype.hasOwnProperty.call(anyError, key)) {
						shape[key] = (anyError as Record<string, unknown>)[key];
					}
				}
			}
			return shape;
		}
		return { context, message: String(error) };
	}
}
