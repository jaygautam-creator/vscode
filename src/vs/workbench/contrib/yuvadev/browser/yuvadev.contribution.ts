/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isWeb } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { listenStream } from '../../../../base/common/stream.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import product from '../../../../platform/product/common/product.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWalkthroughLoose, IWalkthroughsService } from '../../welcomeGettingStarted/browser/gettingStartedService.js';

const YUVADEV_CATEGORY = { value: product.nameShort, original: product.nameShort };
const YUVADEV_WALKTHROUGH_ID = 'YuvaDevSetup';
const YUVADEV_WALKTHROUGH_OPENED_KEY = 'yuvadev.setupWalkthroughOpened';

const YUVADEV_API_URL_SETTING = 'yuvadev.apiUrl';
const YUVADEV_RUNTIME_MODE_SETTING = 'yuvadev.runtimeMode';
const YUVADEV_DEFAULT_LANGUAGE_SETTING = 'yuvadev.defaultLanguage';
const YUVADEV_CLOUD_PROVIDER_SETTING = 'yuvadev.cloudProvider';
const YUVADEV_LOCAL_MODEL_SETTING = 'yuvadev.localModel';
const YUVADEV_OLLAMA_CLOUD_MODEL_SETTING = 'yuvadev.ollamaCloudModel';
const YUVADEV_ONBOARDING_OPEN_SETTING = 'yuvadev.onboarding.openOnStartup';
const YUVADEV_BACKEND_AUTOSTART_SETTING = 'yuvadev.backend.autoStart';
const YUVADEV_AUTH_ACCESS_TOKEN_SECRET = 'yuvadev.auth.accessToken';
const YUVADEV_AUTH_REFRESH_TOKEN_SECRET = 'yuvadev.auth.refreshToken';
const YUVADEV_AUTH_EMAIL_STORAGE_KEY = 'yuvadev.auth.email';
const YUVADEV_DEFAULT_API_URL = 'http://127.0.0.1:8124';
const YUVADEV_OAUTH_POLL_INTERVAL_MS = 3000;
const YUVADEV_OAUTH_POLL_MAX_ATTEMPTS = 40;

type RuntimeMode = 'auto' | 'local' | 'cloud' | 'hybrid';
type CloudProvider = 'auto' | 'ollama_cloud' | 'yuvadev_paid' | 'anthropic' | 'openai' | 'deepseek';
type AccessMode = 'local_unlimited' | 'ollama_cloud_byok' | 'yuvadev_paid';
type ConfigurableCloudProvider = 'ollama_cloud' | 'yuvadev_paid';

interface ValueQuickPickItem<T extends string> extends IQuickPickItem {
	value: T;
}

interface HealthResponse {
	status: string;
	version: string;
	multilingual?: boolean;
	ollama?: {
		available: boolean;
		models: string[];
		primary_model?: string;
		primary_model_ready?: boolean;
		error?: string;
	};
	i18n?: {
		enabled: boolean;
		supported_languages?: string[];
	};
	providers?: Record<string, boolean>;
}

interface AgentStatusResponse {
	version: string;
	active_sessions: number;
	model_router?: {
		primary_provider?: string;
		primary_model?: string;
		healthy?: boolean;
	};
}

interface ProviderSaveResponse {
	status: string;
	providers?: Record<string, boolean>;
	runtime?: {
		primary_provider?: string;
		local_model?: string;
		ollama_cloud_model?: string;
	};
}

type ProviderUpdatePayload = {
	ollama_cloud?: string;
	anthropic?: string;
	openai?: string;
	deepseek?: string;
	primary_provider?: string;
	local_model?: string;
	ollama_cloud_model?: string;
};

interface PasswordlessStartResponse {
	status: string;
	message: string;
	device_id?: string;
}

interface PasswordlessVerifyResponse {
	status: string;
	user_id: string;
	session_handle: string;
}

interface AuthDeviceSessionInfo {
	session_handle: string;
	device_name: string | null;
	created_at: string | null;
	last_seen_at: string | null;
	is_current: boolean;
}

interface AuthRefreshResponse {
	access_token: string;
	token_type: string;
}

interface AuthUserProfile {
	user_id: string;
	email: string;
	is_active: boolean;
}

interface UsageMetricValues {
	tokens: number;
	agent_loops: number;
	build_minutes: number;
}

interface UsagePercentValues {
	tokens: number;
	agent_loops: number;
	build_minutes: number;
}

interface UsageBudgetResponse {
	user_id: string;
	email: string;
	plan: string;
	source: string;
	primary_provider: string;
	local_unlimited: boolean;
	usage_policy: 'local_unlimited' | 'provider_managed' | 'yuvadev_metered';
	period_key: string;
	period_start: string;
	period_end: string;
	usage: UsageMetricValues;
	limits: UsageMetricValues;
	remaining: UsageMetricValues;
	percent_used: UsagePercentValues;
	completed_sessions: number;
	active_sessions: number;
	alerts: string[];
}

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'yuvadev',
	title: localize('yuvadev.configuration.title', 'YuvaDev'),
	type: 'object',
	properties: {
		[YUVADEV_API_URL_SETTING]: {
			type: 'string',
			default: YUVADEV_DEFAULT_API_URL,
			scope: ConfigurationScope.APPLICATION_MACHINE,
			description: localize('yuvadev.configuration.apiUrl', 'Backend URL used by the native YuvaDev IDE experience.'),
		},
		[YUVADEV_RUNTIME_MODE_SETTING]: {
			type: 'string',
			enum: ['auto', 'local', 'cloud', 'hybrid'],
			default: 'auto',
			scope: ConfigurationScope.APPLICATION,
			description: localize('yuvadev.configuration.runtimeMode', 'Controls whether YuvaDev prefers local Ollama, a cloud provider, or automatic fallback.'),
		},
		[YUVADEV_DEFAULT_LANGUAGE_SETTING]: {
			type: 'string',
			enum: ['auto', 'en', 'hi', 'hinglish', 'mr', 'gu', 'ta', 'te', 'bn'],
			default: 'auto',
			scope: ConfigurationScope.APPLICATION,
			description: localize('yuvadev.configuration.defaultLanguage', 'Preferred language for prompts, explanations, and setup guidance.'),
		},
		[YUVADEV_CLOUD_PROVIDER_SETTING]: {
			type: 'string',
			enum: ['auto', 'ollama_cloud', 'yuvadev_paid', 'anthropic', 'openai', 'deepseek'],
			default: 'auto',
			scope: ConfigurationScope.APPLICATION,
			description: localize('yuvadev.configuration.cloudProvider', 'Preferred cloud mode provider when YuvaDev is running outside local unlimited mode.'),
		},
		[YUVADEV_LOCAL_MODEL_SETTING]: {
			type: 'string',
			default: 'qwen3:4b',
			scope: ConfigurationScope.APPLICATION_MACHINE,
			description: localize('yuvadev.configuration.localModel', 'Default Ollama model that YuvaDev should use for local runs.'),
		},
		[YUVADEV_OLLAMA_CLOUD_MODEL_SETTING]: {
			type: 'string',
			default: 'qwen3-coder:480b',
			scope: ConfigurationScope.APPLICATION_MACHINE,
			description: localize('yuvadev.configuration.ollamaCloudModel', 'Model ID for Ollama Cloud BYOK sessions.'),
		},
		[YUVADEV_ONBOARDING_OPEN_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('yuvadev.configuration.onboarding', 'Open the YuvaDev setup walkthrough automatically the first time the IDE starts.'),
		},
		[YUVADEV_BACKEND_AUTOSTART_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('yuvadev.configuration.backendAutostart', 'Automatically start and manage the local YuvaDev backend process when the IDE launches.'),
		},
	},
});

function getApiUrl(configurationService: IConfigurationService): string {
	const configured = configurationService.getValue<string>(YUVADEV_API_URL_SETTING)?.trim();
	return (configured && configured.length > 0 ? configured : YUVADEV_DEFAULT_API_URL).replace(/\/+$/, '');
}

function getRuntimeMode(configurationService: IConfigurationService): RuntimeMode {
	return configurationService.getValue<RuntimeMode>(YUVADEV_RUNTIME_MODE_SETTING) ?? 'auto';
}

function getCloudProvider(configurationService: IConfigurationService): CloudProvider {
	return configurationService.getValue<CloudProvider>(YUVADEV_CLOUD_PROVIDER_SETTING) ?? 'auto';
}

function getLocalModel(configurationService: IConfigurationService): string {
	return configurationService.getValue<string>(YUVADEV_LOCAL_MODEL_SETTING)?.trim() || 'qwen3:4b';
}

function getOllamaCloudModel(configurationService: IConfigurationService): string {
	return configurationService.getValue<string>(YUVADEV_OLLAMA_CLOUD_MODEL_SETTING)?.trim() || 'qwen3-coder:480b';
}

function getAccessModeFromSettings(configurationService: IConfigurationService): AccessMode {
	const runtimeMode = getRuntimeMode(configurationService);
	const cloudProvider = getCloudProvider(configurationService);

	if (runtimeMode === 'local') {
		return 'local_unlimited';
	}
	if (cloudProvider === 'ollama_cloud') {
		return 'ollama_cloud_byok';
	}
	return 'yuvadev_paid';
}

function isConfigurableCloudProvider(provider: CloudProvider): provider is ConfigurableCloudProvider {
	return provider === 'ollama_cloud' || provider === 'yuvadev_paid';
}

function providerLabel(provider: string): string {
	switch (provider) {
		case 'ollama_cloud': return 'Ollama Cloud (BYOK)';
		case 'yuvadev_paid': return 'YuvaDev Paid Models';
		case 'anthropic': return 'Anthropic Claude';
		case 'openai': return 'OpenAI GPT';
		case 'deepseek': return 'DeepSeek';
		case 'ollama': return 'Ollama';
		default: return provider;
	}
}

function getCloudProviderItems(): ValueQuickPickItem<CloudProvider>[] {
	return [
		{
			label: 'Ollama Cloud BYOK',
			description: 'Use your own Ollama API key',
			detail: 'YuvaDev sends requests using your Ollama Cloud key and your selected model.',
			value: 'ollama_cloud',
		},
		{
			label: 'YuvaDev Paid Models',
			description: 'Managed paid routing',
			detail: 'Use YuvaDev paid model routing with platform-managed limits and entitlements.',
			value: 'yuvadev_paid',
		},
	];
}

function getWalkthroughMedia() {
	const mediaRoot = FileAccess.asFileUri('vs/workbench/contrib/welcomeGettingStarted/common/media/');
	return {
		type: 'markdown' as const,
		path: FileAccess.asFileUri('vs/workbench/contrib/welcomeGettingStarted/common/media/empty').with({
			query: JSON.stringify({ moduleId: 'vs/workbench/contrib/welcomeGettingStarted/common/media/empty' }),
		}),
		base: mediaRoot,
		root: mediaRoot,
	};
}

function createYuvaDevWalkthrough(): IWalkthroughLoose {
	return {
		id: YUVADEV_WALKTHROUGH_ID,
		title: localize('yuvadev.walkthrough.title', 'Set up YuvaDev'),
		description: localize('yuvadev.walkthrough.description', 'Choose local unlimited, Ollama Cloud BYOK, or YuvaDev paid mode, then finish account and model setup.'),
		order: 2_000,
		source: product.nameShort,
		isFeatured: true,
		when: ContextKeyExpr.not('isWeb'),
		icon: { type: 'icon', icon: Codicon.rocket },
		walkthroughPageTitle: localize('yuvadev.walkthrough.pageTitle', 'Set up YuvaDev IDE'),
		steps: [
			{
				id: 'yuvadev.runtimeMode',
				title: localize('yuvadev.walkthrough.runtime.title', 'Choose your access mode'),
				description: localize('yuvadev.walkthrough.runtime.description', 'Pick one: local unlimited (your own machine), Ollama Cloud BYOK, or YuvaDev paid models.\n[Choose Runtime Mode](command:yuvadev.chooseRuntimeMode)'),
				category: YUVADEV_WALKTHROUGH_ID,
				when: ContextKeyExpr.true(),
				order: 0,
				completionEvents: ['onSettingChanged:yuvadev.runtimeMode'],
				media: getWalkthroughMedia(),
			},
			{
				id: 'yuvadev.language',
				title: localize('yuvadev.walkthrough.language.title', 'Set your preferred language'),
				description: localize('yuvadev.walkthrough.language.description', 'Prompts and explanations can default to English, Hindi, Hinglish, Marathi, Gujarati, Tamil, Telugu, or Bengali.\n[Set Language](command:yuvadev.chooseLanguage)'),
				category: YUVADEV_WALKTHROUGH_ID,
				when: ContextKeyExpr.true(),
				order: 1,
				completionEvents: ['onSettingChanged:yuvadev.defaultLanguage'],
				media: getWalkthroughMedia(),
			},
			{
				id: 'yuvadev.backendHealth',
				title: localize('yuvadev.walkthrough.health.title', 'Verify backend health'),
				description: localize('yuvadev.walkthrough.health.description', 'Check that the YuvaDev backend is reachable, multilingual support is enabled, and the active model router is healthy.\n[Check Backend Health](command:yuvadev.checkBackendHealth)'),
				category: YUVADEV_WALKTHROUGH_ID,
				when: ContextKeyExpr.true(),
				order: 2,
				completionEvents: ['onCommand:yuvadev.checkBackendHealth'],
				media: getWalkthroughMedia(),
			},
			{
				id: 'yuvadev.providerKey',
				title: localize('yuvadev.walkthrough.provider.title', 'Configure cloud access'),
				description: localize('yuvadev.walkthrough.provider.description', 'For Ollama Cloud BYOK, add your own API key and cloud model ID. For YuvaDev paid mode, just select paid routing (no BYOK key required).\n[Configure Cloud Access](command:yuvadev.configureProviderKey)'),
				category: YUVADEV_WALKTHROUGH_ID,
				when: ContextKeyExpr.true(),
				order: 3,
				completionEvents: ['onCommand:yuvadev.configureProviderKey'],
				media: getWalkthroughMedia(),
			},
			{
				id: 'yuvadev.localModel',
				title: localize('yuvadev.walkthrough.localModel.title', 'Pull your local Ollama model'),
				description: localize('yuvadev.walkthrough.localModel.description', 'Download or select the local model YuvaDev should use for free, on-device coding runs.\n[Pull Local Model](command:yuvadev.pullLocalModel)'),
				category: YUVADEV_WALKTHROUGH_ID,
				when: ContextKeyExpr.true(),
				order: 4,
				completionEvents: ['onCommand:yuvadev.pullLocalModel'],
				media: getWalkthroughMedia(),
			},
			{
				id: 'yuvadev.account',
				title: localize('yuvadev.walkthrough.account.title', 'Sign in to your YuvaDev account'),
				description: localize('yuvadev.walkthrough.account.description', 'Sign in for cloud entitlements, paid routing, and account-linked workspace sessions.\n[Sign In](command:yuvadev.signInAccount)\n[Check Account Status](command:yuvadev.checkAccountStatus)\n[Check Usage & Budget](command:yuvadev.checkUsageAndBudget)'),
				category: YUVADEV_WALKTHROUGH_ID,
				when: ContextKeyExpr.true(),
				order: 5,
				completionEvents: ['onCommand:yuvadev.signInAccount'],
				media: getWalkthroughMedia(),
			},
		],
	};
}

async function requestJson<T>(
	requestService: IRequestService,
	url: string,
	options: { type?: string; data?: string; headers?: Record<string, string> } = {},
): Promise<T> {
	const headers = { ...(options.headers ?? {}) };
	if (options.data && !headers['Content-Type']) {
		headers['Content-Type'] = 'application/json';
	}

	const response = await requestService.request({
		type: options.type ?? 'GET',
		url,
		data: options.data,
		headers: Object.keys(headers).length > 0 ? headers : undefined,
	}, CancellationToken.None);

	const statusCode = response.res.statusCode ?? 0;
	const data = await asJson<T & { detail?: string; message?: string }>(response);

	if (statusCode >= 400) {
		const detail = data && typeof data === 'object'
			? String(data.detail ?? data.message ?? localize('yuvadev.request.errorUnknown', 'Unknown error'))
			: localize('yuvadev.request.errorUnknown', 'Unknown error');
		throw new Error(localize('yuvadev.request.failed', 'YuvaDev backend request failed ({0}): {1}', statusCode, detail));
	}

	if (!data) {
		throw new Error(localize('yuvadev.request.empty', 'YuvaDev backend returned an empty response.'));
	}
	return data as T;
}

async function persistRuntimeSelection(
	accessor: ServicesAccessor,
	payload: ProviderUpdatePayload,
): Promise<ProviderSaveResponse> {
	const configurationService = accessor.get(IConfigurationService);
	const requestService = accessor.get(IRequestService);
	return requestJson<ProviderSaveResponse>(
		requestService,
		`${getApiUrl(configurationService)}/providers`,
		{ type: 'POST', data: JSON.stringify(payload) },
	);
}

async function promptForCloudProvider(
	quickInputService: IQuickInputService,
	currentProvider: CloudProvider,
): Promise<CloudProvider | undefined> {
	const items = getCloudProviderItems().map(item => ({ ...item, picked: item.value === currentProvider }));
	const picked = await quickInputService.pick(items, {
		placeHolder: localize('yuvadev.cloudProvider.placeholder', 'Choose your cloud access option'),
	});
	return picked?.value;
}

async function configureCloudProviderAccess(
	accessor: ServicesAccessor,
	provider: ConfigurableCloudProvider,
): Promise<boolean> {
	const quickInputService = accessor.get(IQuickInputService);
	const configurationService = accessor.get(IConfigurationService);
	const notificationService = accessor.get(INotificationService);

	if (provider === 'yuvadev_paid') {
		await configurationService.updateValue(YUVADEV_CLOUD_PROVIDER_SETTING, provider, ConfigurationTarget.APPLICATION);
		await configurationService.updateValue(YUVADEV_RUNTIME_MODE_SETTING, 'cloud', ConfigurationTarget.APPLICATION);
		try {
			await persistRuntimeSelection(accessor, { primary_provider: 'yuvadev_paid' });
			notificationService.info(localize(
				'yuvadev.providerKey.paid.enabled',
				'YuvaDev paid model routing is enabled. No personal cloud API key is required for this mode.',
			));
			return true;
		} catch (error) {
			notificationService.error(localize(
				'yuvadev.providerKey.failed',
				'Could not save the provider key: {0}',
				error instanceof Error ? error.message : String(error),
			));
			return false;
		}
	}

	const apiKey = await quickInputService.input({
		title: localize('yuvadev.providerKey.title', 'Add Cloud Provider Key'),
		prompt: localize('yuvadev.providerKey.prompt', 'Paste your {0} API key. The value will be stored by the YuvaDev backend.', providerLabel(provider)),
		placeHolder: localize('yuvadev.providerKey.placeholder.ollamaCloud', 'ollama_...'),
		password: true,
		validateInput: async value => value.trim().length > 0 ? undefined : localize('yuvadev.providerKey.required', 'API key is required.'),
	});

	if (!apiKey) {
		return false;
	}

	const model = await quickInputService.input({
		title: localize('yuvadev.ollamaCloudModel.title', 'Ollama Cloud Model ID'),
		prompt: localize('yuvadev.ollamaCloudModel.prompt', 'Enter the Ollama Cloud model ID to use with your API key.'),
		placeHolder: getOllamaCloudModel(configurationService),
		value: getOllamaCloudModel(configurationService),
		validateInput: async value => value.trim().length > 0 ? undefined : localize('yuvadev.ollamaCloudModel.required', 'Model ID is required.'),
	});

	if (!model) {
		return false;
	}

	const ollamaCloudModel = model.trim();
	await configurationService.updateValue(YUVADEV_CLOUD_PROVIDER_SETTING, provider, ConfigurationTarget.APPLICATION);
	await configurationService.updateValue(YUVADEV_RUNTIME_MODE_SETTING, 'cloud', ConfigurationTarget.APPLICATION);
	await configurationService.updateValue(YUVADEV_OLLAMA_CLOUD_MODEL_SETTING, ollamaCloudModel, ConfigurationTarget.APPLICATION);

	const payload: ProviderUpdatePayload = {
		ollama_cloud: apiKey.trim(),
		ollama_cloud_model: ollamaCloudModel,
		primary_provider: provider,
	};

	try {
		await persistRuntimeSelection(accessor, payload);
		notificationService.info(localize(
			'yuvadev.providerKey.saved',
			'{0} key saved. YuvaDev can now use that cloud provider.',
			providerLabel(provider),
		));
		return true;
	} catch (error) {
		notificationService.error(localize(
			'yuvadev.providerKey.failed',
			'Could not save the provider key: {0}',
			error instanceof Error ? error.message : String(error),
		));
		return false;
	}
}

function formatUsageValue(value: number | undefined): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '0';
	}
	return value.toLocaleString();
}

function formatUsagePercent(value: number | undefined): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '0';
	}
	return value.toFixed(2);
}

/*
 * Task 1.5 Manual Verification:
 * 1. Run "Sign In to YuvaDev Account", choose Email OTP, and verify the new OTP prompt appears instead of the old credential prompt.
 * 2. Run "Sign In with Google OAuth", complete browser flow, and confirm polling resolves within 2 minutes.
 * 3. Run "View YuvaDev Device Sessions", confirm active sessions are listed, and revoke a non-current session.
 * 4. Run "Sign Out from YuvaDev Account", confirm logout-all is attempted and local credentials are cleared.
 */
function resolveDeviceId(
	storageService: IStorageService,
	telemetryService: ITelemetryService,
	backendDeviceId?: string,
): string {
	const backend = backendDeviceId?.trim();
	if (backend) {
		return backend;
	}
	const telemetryMachineId = telemetryService.machineId?.trim();
	if (telemetryMachineId) {
		return telemetryMachineId;
	}
	const storedMachineId = storageService.get('storage.serviceMachineId', StorageScope.APPLICATION, '').trim();
	return storedMachineId || 'yuvadev-desktop';
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function formatSessionTimestamp(value: string | null | undefined): string {
	return value && value.trim() ? value : localize('yuvadev.auth.sessions.timestamp.unknown', 'unknown');
}

async function startPasswordlessOtp(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	email: string,
): Promise<PasswordlessStartResponse> {
	return requestJson<PasswordlessStartResponse>(
		requestService,
		`${getApiUrl(configurationService)}/api/auth/passwordless/start`,
		{ type: 'POST', data: JSON.stringify({ email }) },
	);
}

async function verifyPasswordlessOtp(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	email: string,
	code: string,
	deviceId: string,
): Promise<PasswordlessVerifyResponse> {
	return requestJson<PasswordlessVerifyResponse>(
		requestService,
		`${getApiUrl(configurationService)}/api/auth/passwordless/verify`,
		{
			type: 'POST',
			data: JSON.stringify({
				email,
				code,
				device_id: deviceId,
			}),
		},
	);
}

async function listDeviceSessions(
	configurationService: IConfigurationService,
	requestService: IRequestService,
): Promise<AuthDeviceSessionInfo[]> {
	return requestJson<AuthDeviceSessionInfo[]>(
		requestService,
		`${getApiUrl(configurationService)}/api/auth/sessions`,
	);
}

async function revokeDeviceSession(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	sessionHandle: string,
): Promise<void> {
	await requestJson<{ status: string }>(
		requestService,
		`${getApiUrl(configurationService)}/api/auth/sessions/${encodeURIComponent(sessionHandle)}/revoke`,
		{ type: 'POST' },
	);
}

async function logoutAllDeviceSessions(
	configurationService: IConfigurationService,
	requestService: IRequestService,
): Promise<void> {
	await requestJson<{ status: string }>(
		requestService,
		`${getApiUrl(configurationService)}/api/auth/logout-all`,
		{ type: 'POST' },
	);
}

async function pollForOAuthProfile(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	progressService: IProgressService,
): Promise<AuthUserProfile> {
	let cancelled = false;
	let profile: AuthUserProfile | undefined;
	const cancelledMessage = localize('yuvadev.auth.oauth.cancelled', 'Google OAuth sign-in was cancelled.');
	const timeoutMessage = localize(
		'yuvadev.auth.oauth.timeout',
		'Google OAuth sign-in did not complete within {0} seconds.',
		Math.floor((YUVADEV_OAUTH_POLL_INTERVAL_MS * YUVADEV_OAUTH_POLL_MAX_ATTEMPTS) / 1000),
	);

	await progressService.withProgress<void>({
		location: ProgressLocation.Notification,
		title: localize('yuvadev.auth.oauth.polling', 'Waiting for Google OAuth sign-in'),
		cancellable: true,
	}, async progress => {
		for (let attempt = 1; attempt <= YUVADEV_OAUTH_POLL_MAX_ATTEMPTS; attempt++) {
			if (cancelled) {
				throw new Error(cancelledMessage);
			}

			progress.report({
				message: localize(
					'yuvadev.auth.oauth.polling.attempt',
					'Checking sign-in status ({0}/{1})...',
					attempt,
					YUVADEV_OAUTH_POLL_MAX_ATTEMPTS,
				),
			});

			try {
				profile = await requestJson<AuthUserProfile>(
					requestService,
					`${getApiUrl(configurationService)}/api/auth/me`,
				);
				return;
			} catch {
				// Continue polling while the browser flow completes.
			}

			if (attempt < YUVADEV_OAUTH_POLL_MAX_ATTEMPTS) {
				await sleep(YUVADEV_OAUTH_POLL_INTERVAL_MS);
			}
		}
	}, () => {
		cancelled = true;
	});

	if (profile) {
		return profile;
	}
	if (cancelled) {
		throw new Error(cancelledMessage);
	}
	throw new Error(timeoutMessage);
}

async function runOtpSignIn(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const requestService = accessor.get(IRequestService);
	const configurationService = accessor.get(IConfigurationService);
	const notificationService = accessor.get(INotificationService);
	const progressService = accessor.get(IProgressService);
	const storageService = accessor.get(IStorageService);
	const secretStorageService = accessor.get(ISecretStorageService);
	const telemetryService = accessor.get(ITelemetryService);

	const rememberedEmail = storageService.get(YUVADEV_AUTH_EMAIL_STORAGE_KEY, StorageScope.APPLICATION, '');
	const email = await quickInputService.input({
		title: localize('yuvadev.auth.email.title', 'YuvaDev Account Email'),
		prompt: localize('yuvadev.auth.email.prompt', 'Enter your YuvaDev account email address.'),
		value: rememberedEmail,
		placeHolder: localize('yuvadev.auth.email.placeholder', 'you@company.com'),
		validateInput: async value => value.includes('@') ? undefined : localize('yuvadev.auth.email.invalid', 'Enter a valid email address.'),
	});
	if (!email) {
		return;
	}

	try {
		const startResponse = await progressService.withProgress<PasswordlessStartResponse>({
			location: ProgressLocation.Notification,
			title: localize('yuvadev.auth.otp.starting', 'Sending one-time code'),
			cancellable: false,
		}, async () => startPasswordlessOtp(configurationService, requestService, email.trim()));

		const code = await quickInputService.input({
			title: localize('yuvadev.auth.otp.code.title', 'Enter OTP Code'),
			prompt: localize('yuvadev.auth.otp.code.prompt', 'Enter the one-time code sent to your email.'),
			placeHolder: localize('yuvadev.auth.otp.code.placeholder', '123456'),
			validateInput: async value => value.trim().length > 0 ? undefined : localize('yuvadev.auth.otp.code.required', 'OTP code is required.'),
		});
		if (!code) {
			return;
		}

		const deviceId = resolveDeviceId(storageService, telemetryService, startResponse.device_id);
		const verifyResult = await progressService.withProgress<PasswordlessVerifyResponse>({
			location: ProgressLocation.Notification,
			title: localize('yuvadev.auth.otp.verifying', 'Verifying one-time code'),
			cancellable: false,
		}, async () => verifyPasswordlessOtp(configurationService, requestService, email.trim(), code.trim(), deviceId));

		await clearAuthTokens(secretStorageService);
		storageService.store(YUVADEV_AUTH_EMAIL_STORAGE_KEY, email.trim(), StorageScope.APPLICATION, StorageTarget.USER);

		notificationService.info(localize(
			'yuvadev.auth.otp.success',
			'Signed in with OTP as {0}. Session {1} is active on this device.',
			email.trim(),
			verifyResult.session_handle,
		));
	} catch (error) {
		await clearAuthTokens(secretStorageService);
		notificationService.error(localize(
			'yuvadev.auth.otp.failed',
			'OTP sign-in failed: {0}',
			error instanceof Error ? error.message : String(error),
		));
	}
}

async function runGoogleOAuthSignIn(accessor: ServicesAccessor): Promise<void> {
	const requestService = accessor.get(IRequestService);
	const configurationService = accessor.get(IConfigurationService);
	const notificationService = accessor.get(INotificationService);
	const progressService = accessor.get(IProgressService);
	const storageService = accessor.get(IStorageService);
	const secretStorageService = accessor.get(ISecretStorageService);
	const openerService = accessor.get(IOpenerService);

	try {
		const startUrl = `${getApiUrl(configurationService)}/api/auth/oauth/google/start`;
		await openerService.open(URI.parse(startUrl));

		const profile = await pollForOAuthProfile(configurationService, requestService, progressService);

		await clearAuthTokens(secretStorageService);
		storageService.store(YUVADEV_AUTH_EMAIL_STORAGE_KEY, profile.email, StorageScope.APPLICATION, StorageTarget.USER);

		notificationService.info(localize(
			'yuvadev.auth.oauth.success',
			'Signed in with Google OAuth as {0}.',
			profile.email,
		));
	} catch (error) {
		notificationService.error(localize(
			'yuvadev.auth.oauth.failed',
			'Google OAuth sign-in failed: {0}',
			error instanceof Error ? error.message : String(error),
		));
	}
}

async function readAuthTokens(secretStorageService: ISecretStorageService): Promise<{ accessToken?: string; refreshToken?: string }> {
	const [accessToken, refreshToken] = await Promise.all([
		secretStorageService.get(YUVADEV_AUTH_ACCESS_TOKEN_SECRET),
		secretStorageService.get(YUVADEV_AUTH_REFRESH_TOKEN_SECRET),
	]);

	return { accessToken: accessToken || undefined, refreshToken: refreshToken || undefined };
}

async function clearAuthTokens(secretStorageService: ISecretStorageService): Promise<void> {
	await Promise.all([
		secretStorageService.delete(YUVADEV_AUTH_ACCESS_TOKEN_SECRET),
		secretStorageService.delete(YUVADEV_AUTH_REFRESH_TOKEN_SECRET),
	]);
}

async function refreshYuvaDevAccessToken(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	secretStorageService: ISecretStorageService,
): Promise<string | undefined> {
	const refreshToken = await secretStorageService.get(YUVADEV_AUTH_REFRESH_TOKEN_SECRET);
	if (!refreshToken) {
		return undefined;
	}

	const refreshed = await requestJson<AuthRefreshResponse>(
		requestService,
		`${getApiUrl(configurationService)}/api/auth/refresh`,
		{ type: 'POST', data: JSON.stringify({ refresh_token: refreshToken }) },
	);

	await secretStorageService.set(YUVADEV_AUTH_ACCESS_TOKEN_SECRET, refreshed.access_token);
	return refreshed.access_token;
}

async function requestWithYuvaDevAuth<T>(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	secretStorageService: ISecretStorageService,
	path: string,
): Promise<T> {
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	const callWithToken = async (accessToken: string) => requestJson<T>(
		requestService,
		`${getApiUrl(configurationService)}${normalizedPath}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
	);

	const tokens = await readAuthTokens(secretStorageService);
	let accessToken = tokens.accessToken;

	if (!accessToken) {
		accessToken = await refreshYuvaDevAccessToken(configurationService, requestService, secretStorageService);
	}

	if (!accessToken) {
		throw new Error(localize('yuvadev.auth.notSignedIn', 'No active YuvaDev account session found.'));
	}

	try {
		return await callWithToken(accessToken);
	} catch {
		const refreshedAccess = await refreshYuvaDevAccessToken(configurationService, requestService, secretStorageService);
		if (!refreshedAccess) {
			throw new Error(localize('yuvadev.auth.sessionExpired', 'Your YuvaDev session expired. Please sign in again.'));
		}
		return callWithToken(refreshedAccess);
	}
}

async function fetchYuvaDevProfile(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	secretStorageService: ISecretStorageService,
): Promise<AuthUserProfile> {
	try {
		return await requestJson<AuthUserProfile>(
			requestService,
			`${getApiUrl(configurationService)}/api/auth/me`,
		);
	} catch {
		return requestWithYuvaDevAuth<AuthUserProfile>(
			configurationService,
			requestService,
			secretStorageService,
			'/api/auth/me',
		);
	}
}

async function fetchYuvaDevUsageBudget(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	secretStorageService: ISecretStorageService,
): Promise<UsageBudgetResponse> {
	return requestWithYuvaDevAuth<UsageBudgetResponse>(
		configurationService,
		requestService,
		secretStorageService,
		'/api/auth/usage',
	);
}

async function confirmWizardStep(
	quickInputService: IQuickInputService,
	title: string,
	detail: string,
): Promise<boolean> {
	const picked = await quickInputService.pick<ValueQuickPickItem<'yes' | 'skip'>>([
		{
			label: localize('yuvadev.wizard.choice.continue', 'Continue'),
			description: localize('yuvadev.wizard.choice.continue.description', 'Run this setup step now'),
			value: 'yes',
		},
		{
			label: localize('yuvadev.wizard.choice.skip', 'Skip for now'),
			description: localize('yuvadev.wizard.choice.skip.description', 'You can run this step later from Command Palette'),
			value: 'skip',
		},
	], {
		title,
		placeHolder: detail,
		ignoreFocusLost: true,
	});

	return picked?.value === 'yes';
}

registerAction2(class OpenYuvaDevSetupAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.openSetup',
			title: localize2('yuvadev.openSetup', 'Open YuvaDev Setup'),
			category: Categories.Help,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
			menu: [{
				id: MenuId.MenubarHelpMenu,
				group: '1_welcome',
				order: 2,
				when: ContextKeyExpr.not('isWeb'),
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('yuvadev.runOnboardingWizard');
	}
});

registerAction2(class RunYuvaDevOnboardingWizardAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.runOnboardingWizard',
			title: localize2('yuvadev.runOnboardingWizard', 'Run YuvaDev Setup Wizard'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);

		const shouldStart = await confirmWizardStep(
			quickInputService,
			localize('yuvadev.wizard.start.title', 'YuvaDev Guided Setup'),
			localize('yuvadev.wizard.start.detail', 'Run the full setup now: choose local unlimited, Ollama Cloud BYOK, or YuvaDev paid mode, then complete language, health, provider, and account steps.'),
		);

		if (!shouldStart) {
			await commandService.executeCommand('workbench.action.openWalkthrough', YUVADEV_WALKTHROUGH_ID);
			return;
		}

		await commandService.executeCommand('yuvadev.chooseRuntimeMode');
		await commandService.executeCommand('yuvadev.chooseLanguage');
		await commandService.executeCommand('yuvadev.checkBackendHealth');

		const accessMode = getAccessModeFromSettings(configurationService);

		if (accessMode === 'ollama_cloud_byok' || accessMode === 'yuvadev_paid') {
			const shouldConfigureCloud = await confirmWizardStep(
				quickInputService,
				localize('yuvadev.wizard.cloud.title', 'Configure Cloud Provider'),
				accessMode === 'ollama_cloud_byok'
					? localize('yuvadev.wizard.cloud.detail.byok', 'Connect your Ollama Cloud API key and model ID.')
					: localize('yuvadev.wizard.cloud.detail.paid', 'Activate YuvaDev paid routing (no personal cloud key required).'),
			);
			if (shouldConfigureCloud) {
				await commandService.executeCommand('yuvadev.configureProviderKey');
			}
		}

		if (accessMode === 'local_unlimited') {
			const shouldPullModel = await confirmWizardStep(
				quickInputService,
				localize('yuvadev.wizard.local.title', 'Prepare Local Model'),
				localize('yuvadev.wizard.local.detail', 'Pull an Ollama model for free local execution.'),
			);
			if (shouldPullModel) {
				await commandService.executeCommand('yuvadev.pullLocalModel');
			}
		}

		const shouldSignIn = await confirmWizardStep(
			quickInputService,
			localize('yuvadev.wizard.account.title', 'Sign In Account'),
			localize('yuvadev.wizard.account.detail', 'Sign in to your YuvaDev account for cloud entitlements and paid features.'),
		);
		if (shouldSignIn) {
			await commandService.executeCommand('yuvadev.signInAccount');
		}

		await commandService.executeCommand('workbench.action.openWalkthrough', YUVADEV_WALKTHROUGH_ID);
		notificationService.info(localize(
			'yuvadev.wizard.complete',
			'YuvaDev guided setup is complete. You can rerun it anytime with "Run YuvaDev Setup Wizard".',
		));
	}
});

registerAction2(class SignInYuvaDevAccountAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.signInAccount',
			title: localize2('yuvadev.signInAccount', 'Sign In to YuvaDev Account'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const picked = await quickInputService.pick<ValueQuickPickItem<'otp' | 'google'>>([
			{
				label: localize('yuvadev.auth.method.otp.label', 'Email OTP'),
				description: localize('yuvadev.auth.method.otp.description', 'Receive a one-time code by email'),
				value: 'otp',
			},
			{
				label: localize('yuvadev.auth.method.google.label', 'Google OAuth'),
				description: localize('yuvadev.auth.method.google.description', 'Continue in your browser with Google'),
				value: 'google',
			},
		], {
			title: localize('yuvadev.auth.method.title', 'Choose sign-in method'),
			placeHolder: localize('yuvadev.auth.method.placeholder', 'Select Email OTP or Google OAuth'),
			ignoreFocusLost: true,
		});

		if (!picked) {
			return;
		}

		if (picked.value === 'otp') {
			await runOtpSignIn(accessor);
			return;
		}

		await runGoogleOAuthSignIn(accessor);
	}
});

registerAction2(class SignInYuvaDevGoogleOAuthAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.signInWithGoogleOAuth',
			title: localize2('yuvadev.signInWithGoogleOAuth', 'Sign In with Google OAuth'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await runGoogleOAuthSignIn(accessor);
	}
});

registerAction2(class CheckYuvaDevAccountStatusAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.checkAccountStatus',
			title: localize2('yuvadev.checkAccountStatus', 'Check YuvaDev Account Status'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const requestService = accessor.get(IRequestService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const secretStorageService = accessor.get(ISecretStorageService);

		try {
			const profile = await fetchYuvaDevProfile(configurationService, requestService, secretStorageService);
			notificationService.info(localize(
				'yuvadev.auth.status.active',
				'YuvaDev account is connected: {0} (active: {1}).',
				profile.email,
				profile.is_active ? 'yes' : 'no',
			));
		} catch (error) {
			await clearAuthTokens(secretStorageService);
			notificationService.warn(localize(
				'yuvadev.auth.status.none',
				'No valid YuvaDev account session found. Sign in to enable account-linked features. ({0})',
				error instanceof Error ? error.message : String(error),
			));
		}
	}
});

registerAction2(class CheckYuvaDevUsageAndBudgetAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.checkUsageAndBudget',
			title: localize2('yuvadev.checkUsageAndBudget', 'Check YuvaDev Usage and Budget'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const requestService = accessor.get(IRequestService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const secretStorageService = accessor.get(ISecretStorageService);

		try {
			const usage = await fetchYuvaDevUsageBudget(configurationService, requestService, secretStorageService);
			if (usage.usage_policy === 'local_unlimited') {
				notificationService.info(localize(
					'yuvadev.usage.summary.localUnlimited',
					'Local runtime ({0}) is active. Local LLM usage is unlimited on this device. Cloud snapshot for plan {1}: tokens {2}/{3}, loops {4}/{5}.',
					providerLabel(usage.primary_provider),
					usage.plan.toUpperCase(),
					formatUsageValue(usage.usage.tokens),
					formatUsageValue(usage.limits.tokens),
					formatUsageValue(usage.usage.agent_loops),
					formatUsageValue(usage.limits.agent_loops),
				));
			} else if (usage.usage_policy === 'provider_managed') {
				notificationService.info(localize(
					'yuvadev.usage.summary.providerManaged',
					'{0} mode is active. This mode uses your personal provider limits (for example Ollama Cloud daily/weekly caps), not YuvaDev paid quotas.',
					providerLabel(usage.primary_provider),
				));
			} else {
				notificationService.info(localize(
					'yuvadev.usage.summary',
					'Plan {0}. Tokens {1}/{2} ({3}%). Loops {4}/{5} ({6}%). Build minutes {7}/{8} ({9}%). Active sessions: {10}.',
					usage.plan.toUpperCase(),
					formatUsageValue(usage.usage.tokens),
					formatUsageValue(usage.limits.tokens),
					formatUsagePercent(usage.percent_used.tokens),
					formatUsageValue(usage.usage.agent_loops),
					formatUsageValue(usage.limits.agent_loops),
					formatUsagePercent(usage.percent_used.agent_loops),
					formatUsageValue(usage.usage.build_minutes),
					formatUsageValue(usage.limits.build_minutes),
					formatUsagePercent(usage.percent_used.build_minutes),
					formatUsageValue(usage.active_sessions),
				));
			}

			if (usage.alerts.length > 0) {
				notificationService.warn(localize(
					'yuvadev.usage.alerts',
					'Usage alerts: {0}',
					usage.alerts.join(' '),
				));
			}
		} catch (error) {
			await clearAuthTokens(secretStorageService);
			notificationService.warn(localize(
				'yuvadev.usage.failed',
				'Could not load YuvaDev usage and budget details. Sign in again to continue. ({0})',
				error instanceof Error ? error.message : String(error),
			));
		}
	}
});

registerAction2(class ShowYuvaDevUsageBreakdownAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.showUsageBreakdown',
			title: localize2('yuvadev.showUsageBreakdown', 'Show YuvaDev Usage Breakdown'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const requestService = accessor.get(IRequestService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const secretStorageService = accessor.get(ISecretStorageService);

		try {
			const usage = await fetchYuvaDevUsageBudget(configurationService, requestService, secretStorageService);
			await quickInputService.pick([
				{
					label: localize('yuvadev.usage.breakdown.mode', 'Runtime policy'),
					description: usage.usage_policy === 'local_unlimited'
						? localize('yuvadev.usage.breakdown.mode.localUnlimited', 'Local LLM usage is unlimited')
						: usage.usage_policy === 'provider_managed'
							? localize('yuvadev.usage.breakdown.mode.providerManaged', 'Provider-managed limits (BYOK mode)')
							: localize('yuvadev.usage.breakdown.mode.cloudMetered', 'Cloud usage is metered by YuvaDev plan limits'),
					detail: localize('yuvadev.usage.breakdown.modeProvider', 'Active provider: {0}', providerLabel(usage.primary_provider)),
				},
				{
					label: localize('yuvadev.usage.breakdown.plan', 'Plan'),
					description: usage.plan.toUpperCase(),
					detail: localize('yuvadev.usage.breakdown.period', 'Period {0} to {1}', usage.period_start || 'n/a', usage.period_end || 'n/a'),
				},
				{
					label: localize('yuvadev.usage.breakdown.tokens', 'Tokens'),
					description: `${formatUsageValue(usage.usage.tokens)} / ${formatUsageValue(usage.limits.tokens)} (${formatUsagePercent(usage.percent_used.tokens)}%)`,
					detail: localize('yuvadev.usage.breakdown.tokensRemaining', 'Remaining: {0}', formatUsageValue(usage.remaining.tokens)),
				},
				{
					label: localize('yuvadev.usage.breakdown.loops', 'Agent loops'),
					description: `${formatUsageValue(usage.usage.agent_loops)} / ${formatUsageValue(usage.limits.agent_loops)} (${formatUsagePercent(usage.percent_used.agent_loops)}%)`,
					detail: localize('yuvadev.usage.breakdown.loopsRemaining', 'Remaining: {0}', formatUsageValue(usage.remaining.agent_loops)),
				},
				{
					label: localize('yuvadev.usage.breakdown.minutes', 'Build minutes'),
					description: `${formatUsageValue(usage.usage.build_minutes)} / ${formatUsageValue(usage.limits.build_minutes)} (${formatUsagePercent(usage.percent_used.build_minutes)}%)`,
					detail: localize('yuvadev.usage.breakdown.minutesRemaining', 'Remaining: {0}', formatUsageValue(usage.remaining.build_minutes)),
				},
				{
					label: localize('yuvadev.usage.breakdown.sessions', 'Agent sessions'),
					description: localize('yuvadev.usage.breakdown.sessionsDescription', 'Completed: {0} | Active: {1}', formatUsageValue(usage.completed_sessions), formatUsageValue(usage.active_sessions)),
					detail: localize('yuvadev.usage.breakdown.source', 'Source: {0}', usage.source),
				},
				{
					label: localize('yuvadev.usage.breakdown.alerts', 'Alerts'),
					description: usage.alerts.length > 0 ? localize('yuvadev.usage.breakdown.alertsCount', '{0} active', usage.alerts.length) : localize('yuvadev.usage.breakdown.alertsNone', 'None'),
					detail: usage.alerts.length > 0 ? usage.alerts.join(' ') : localize('yuvadev.usage.breakdown.alertsClear', 'All usage signals are within configured limits.'),
				},
			], {
				title: localize('yuvadev.usage.breakdown.title', 'YuvaDev Usage and Budget Breakdown'),
				placeHolder: localize('yuvadev.usage.breakdown.placeholder', 'Snapshot of your current monthly usage and limits'),
				ignoreFocusLost: true,
			});
		} catch (error) {
			await clearAuthTokens(secretStorageService);
			notificationService.warn(localize(
				'yuvadev.usage.breakdown.failed',
				'Could not load usage breakdown. Sign in again to continue. ({0})',
				error instanceof Error ? error.message : String(error),
			));
		}
	}
});

registerAction2(class SignOutYuvaDevAccountAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.signOutAccount',
			title: localize2('yuvadev.signOutAccount', 'Sign Out from YuvaDev Account'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const requestService = accessor.get(IRequestService);
		const configurationService = accessor.get(IConfigurationService);
		const secretStorageService = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);
		let revokeError: string | undefined;

		try {
			await logoutAllDeviceSessions(configurationService, requestService);
		} catch (error) {
			revokeError = error instanceof Error ? error.message : String(error);
		}

		await clearAuthTokens(secretStorageService);

		if (revokeError) {
			notificationService.warn(localize(
				'yuvadev.auth.signOut.partial',
				'Local credentials were cleared, but backend session revoke failed: {0}',
				revokeError,
			));
			return;
		}

		notificationService.info(localize(
			'yuvadev.auth.signOut.complete',
			'Signed out from YuvaDev account on this device and requested server-side session revoke.',
		));
	}
});

registerAction2(class ViewYuvaDevSessionsAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.viewSessions',
			title: localize2('yuvadev.viewSessions', 'View YuvaDev Device Sessions'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const requestService = accessor.get(IRequestService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);

		try {
			const sessions = await listDeviceSessions(configurationService, requestService);
			if (sessions.length === 0) {
				notificationService.info(localize('yuvadev.auth.sessions.empty', 'No active YuvaDev sessions were found.'));
				return;
			}

			interface SessionPickItem extends IQuickPickItem {
				sessionHandle: string;
				isCurrent: boolean;
			}

			const picked = await quickInputService.pick<SessionPickItem>(
				sessions.map(session => ({
					label: session.is_current
						? localize('yuvadev.auth.sessions.currentLabel', '$(check) {0}', session.device_name || 'Current device')
						: (session.device_name || localize('yuvadev.auth.sessions.unknownDevice', 'Unknown device')),
					description: session.is_current
						? localize('yuvadev.auth.sessions.currentDescription', 'Current session')
						: localize('yuvadev.auth.sessions.remoteDescription', 'Revocable session'),
					detail: localize(
						'yuvadev.auth.sessions.detail',
						'Created: {0} | Last seen: {1}',
						formatSessionTimestamp(session.created_at),
						formatSessionTimestamp(session.last_seen_at),
					),
					sessionHandle: session.session_handle,
					isCurrent: session.is_current,
				})),
				{
					title: localize('yuvadev.auth.sessions.title', 'Active YuvaDev Device Sessions'),
					placeHolder: localize('yuvadev.auth.sessions.placeholder', 'Select a session to view or revoke'),
					ignoreFocusLost: true,
				},
			);

			if (!picked) {
				return;
			}

			if (picked.isCurrent) {
				notificationService.info(localize('yuvadev.auth.sessions.currentSelected', 'This is your current active session.'));
				return;
			}

			const confirm = await quickInputService.pick<ValueQuickPickItem<'revoke' | 'cancel'>>([
				{
					label: localize('yuvadev.auth.sessions.revoke.confirm', 'Revoke selected session'),
					value: 'revoke',
				},
				{
					label: localize('yuvadev.auth.sessions.revoke.cancel', 'Cancel'),
					value: 'cancel',
				},
			], {
				title: localize('yuvadev.auth.sessions.revoke.title', 'Revoke device session'),
				placeHolder: localize('yuvadev.auth.sessions.revoke.placeholder', 'Confirm revocation'),
				ignoreFocusLost: true,
			});

			if (!confirm || confirm.value !== 'revoke') {
				return;
			}

			await revokeDeviceSession(configurationService, requestService, picked.sessionHandle);
			notificationService.info(localize(
				'yuvadev.auth.sessions.revoke.success',
				'Session revoked: {0}',
				picked.sessionHandle,
			));
		} catch (error) {
			notificationService.warn(localize(
				'yuvadev.auth.sessions.failed',
				'Could not load or modify device sessions: {0}',
				error instanceof Error ? error.message : String(error),
			));
		}
	}
});

registerAction2(class ChooseYuvaDevRuntimeModeAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.chooseRuntimeMode',
			title: localize2('yuvadev.chooseRuntimeMode', 'Choose YuvaDev Runtime Mode'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);

		const currentAccessMode = getAccessModeFromSettings(configurationService);
		const picked = await quickInputService.pick<ValueQuickPickItem<AccessMode>>([
			{
				label: 'Local Unlimited',
				description: 'Your own local LLM via Ollama',
				detail: 'Use your own machine and model. YuvaDev does not enforce usage limits in this mode.',
				value: 'local_unlimited',
				picked: currentAccessMode === 'local_unlimited',
			},
			{
				label: 'Ollama Cloud BYOK',
				description: 'Use your own Ollama Cloud API key',
				detail: 'Enter your personal Ollama API key and model ID. Ollama Cloud limits apply from your own account.',
				value: 'ollama_cloud_byok',
				picked: currentAccessMode === 'ollama_cloud_byok',
			},
			{
				label: 'YuvaDev Paid Models',
				description: 'Managed paid routing',
				detail: 'Use YuvaDev paid model routing with platform-managed limits and account entitlements.',
				value: 'yuvadev_paid',
				picked: currentAccessMode === 'yuvadev_paid',
			},
		], {
			placeHolder: localize('yuvadev.runtimeMode.placeholder', 'Choose how YuvaDev should execute tasks'),
		});

		if (!picked) {
			return;
		}

		if (picked.value === 'local_unlimited') {
			await configurationService.updateValue(YUVADEV_RUNTIME_MODE_SETTING, 'local', ConfigurationTarget.APPLICATION);
			await configurationService.updateValue(YUVADEV_CLOUD_PROVIDER_SETTING, 'auto', ConfigurationTarget.APPLICATION);

			try {
				await persistRuntimeSelection(accessor, { primary_provider: 'ollama' });
			} catch (error) {
				notificationService.warn(localize(
					'yuvadev.runtimeMode.backendWarning',
					'Runtime mode was saved in the IDE, but the backend could not be updated yet: {0}',
					error instanceof Error ? error.message : String(error),
				));
			}

			notificationService.info(localize(
				'yuvadev.runtimeMode.updated',
				'YuvaDev mode set to {0}.',
				picked.label,
			));
			return;
		}

		if (picked.value === 'ollama_cloud_byok') {
			const configured = await configureCloudProviderAccess(accessor, 'ollama_cloud');
			if (!configured) {
				notificationService.info(localize(
					'yuvadev.runtimeMode.byok.cancelled',
					'Ollama Cloud BYOK setup was cancelled. Runtime mode was not changed.',
				));
			}
			return;
		}

		await configureCloudProviderAccess(accessor, 'yuvadev_paid');
	}
});

registerAction2(class ChooseYuvaDevLanguageAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.chooseLanguage',
			title: localize2('yuvadev.chooseLanguage', 'Choose YuvaDev Language'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const currentLanguage = configurationService.getValue<string>(YUVADEV_DEFAULT_LANGUAGE_SETTING) ?? 'auto';

		const picked = await quickInputService.pick<ValueQuickPickItem<string>>([
			{ label: 'Auto', description: 'Detect automatically', value: 'auto', picked: currentLanguage === 'auto' },
			{ label: 'English', description: 'en', value: 'en', picked: currentLanguage === 'en' },
			{ label: 'Hindi', description: 'hi', value: 'hi', picked: currentLanguage === 'hi' },
			{ label: 'Hinglish', description: 'Hindi + English', value: 'hinglish', picked: currentLanguage === 'hinglish' },
			{ label: 'Marathi', description: 'mr', value: 'mr', picked: currentLanguage === 'mr' },
			{ label: 'Gujarati', description: 'gu', value: 'gu', picked: currentLanguage === 'gu' },
			{ label: 'Tamil', description: 'ta', value: 'ta', picked: currentLanguage === 'ta' },
			{ label: 'Telugu', description: 'te', value: 'te', picked: currentLanguage === 'te' },
			{ label: 'Bengali', description: 'bn', value: 'bn', picked: currentLanguage === 'bn' },
		], {
			placeHolder: localize('yuvadev.language.placeholder', 'Choose the default language for YuvaDev'),
		});

		if (!picked) {
			return;
		}

		await configurationService.updateValue(YUVADEV_DEFAULT_LANGUAGE_SETTING, picked.value, ConfigurationTarget.APPLICATION);
		notificationService.info(localize(
			'yuvadev.language.updated',
			'YuvaDev language preference set to {0}.',
			picked.label,
		));
	}
});

registerAction2(class ChooseYuvaDevCloudProviderAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.chooseCloudProvider',
			title: localize2('yuvadev.chooseCloudProvider', 'Choose YuvaDev Cloud Provider'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const currentProvider = getCloudProvider(configurationService);
		const provider = await promptForCloudProvider(quickInputService, currentProvider);

		if (!provider) {
			return;
		}

		await configurationService.updateValue(YUVADEV_CLOUD_PROVIDER_SETTING, provider, ConfigurationTarget.APPLICATION);
		if (provider === 'ollama_cloud' || provider === 'yuvadev_paid') {
			await configurationService.updateValue(YUVADEV_RUNTIME_MODE_SETTING, 'cloud', ConfigurationTarget.APPLICATION);
		}

		if (getRuntimeMode(configurationService) === 'cloud') {
			try {
				const payload: ProviderUpdatePayload = { primary_provider: provider };
				if (provider === 'ollama_cloud') {
					payload.ollama_cloud_model = getOllamaCloudModel(configurationService);
				}
				await persistRuntimeSelection(accessor, payload);
			} catch (error) {
				notificationService.warn(localize(
					'yuvadev.cloudProvider.backendWarning',
					'Cloud provider was saved in the IDE, but the backend could not be updated yet: {0}',
					error instanceof Error ? error.message : String(error),
				));
			}
		}

		if (provider === 'ollama_cloud') {
			notificationService.info(localize(
				'yuvadev.cloudProvider.updated.byok',
				'YuvaDev cloud provider set to {0}. Run "Add YuvaDev Cloud Provider Key" to enter your Ollama key and model.',
				providerLabel(provider),
			));
		} else {
			notificationService.info(localize(
				'yuvadev.cloudProvider.updated',
				'YuvaDev cloud provider set to {0}.',
				providerLabel(provider),
			));
		}
	}
});

registerAction2(class CheckYuvaDevBackendHealthAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.checkBackendHealth',
			title: localize2('yuvadev.checkBackendHealth', 'Check YuvaDev Backend Health'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const requestService = accessor.get(IRequestService);
		const notificationService = accessor.get(INotificationService);
		const apiUrl = getApiUrl(configurationService);

		try {
			const [health, agentStatus] = await Promise.all([
				requestJson<HealthResponse>(requestService, `${apiUrl}/health`),
				requestJson<AgentStatusResponse>(requestService, `${apiUrl}/api/v3/agent/status`),
			]);

			const ollamaState = health.ollama?.available
				? localize('yuvadev.health.ollamaReady', 'Ollama ready ({0} model(s))', health.ollama?.models?.length ?? 0)
				: localize('yuvadev.health.ollamaMissing', 'Ollama unavailable');
			const provider = agentStatus.model_router?.primary_provider ? providerLabel(agentStatus.model_router.primary_provider) : 'Auto';
			const multilingual = health.i18n?.enabled ?? health.multilingual ?? false;
			const cloudCount = Object.values(health.providers ?? {}).filter(Boolean).length;

			notificationService.info(localize(
				'yuvadev.health.ok',
				'YuvaDev backend is healthy at {0}. Active provider: {1}. {2}. Cloud keys configured: {3}. Multilingual: {4}.',
				apiUrl,
				provider,
				ollamaState,
				cloudCount,
				multilingual ? 'on' : 'off',
			));
		} catch (error) {
			notificationService.error(localize(
				'yuvadev.health.failed',
				'YuvaDev backend is not reachable at {0}: {1}',
				apiUrl,
				error instanceof Error ? error.message : String(error),
			));
		}
	}
});

registerAction2(class ConfigureYuvaDevProviderKeyAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.configureProviderKey',
			title: localize2('yuvadev.configureProviderKey', 'Add YuvaDev Cloud Provider Key'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const currentProvider = getCloudProvider(configurationService);
		const provider = await promptForCloudProvider(quickInputService, currentProvider);

		if (!provider) {
			return;
		}

		if (!isConfigurableCloudProvider(provider)) {
			return;
		}

		await configureCloudProviderAccess(accessor, provider);
	}
});

registerAction2(class PullYuvaDevLocalModelAction extends Action2 {
	constructor() {
		super({
			id: 'yuvadev.pullLocalModel',
			title: localize2('yuvadev.pullLocalModel', 'Pull YuvaDev Local Model'),
			category: YUVADEV_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.not('isWeb'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const requestService = accessor.get(IRequestService);
		const progressService = accessor.get(IProgressService);
		const notificationService = accessor.get(INotificationService);
		const apiUrl = getApiUrl(configurationService);

		const model = await quickInputService.input({
			title: localize('yuvadev.localModel.title', 'Pull Local Ollama Model'),
			prompt: localize('yuvadev.localModel.prompt', 'Enter the Ollama model YuvaDev should use for local runs.'),
			placeHolder: getLocalModel(configurationService),
			value: getLocalModel(configurationService),
			validateInput: async value => value.trim().length > 0 ? undefined : localize('yuvadev.localModel.required', 'A model name is required.'),
		});

		if (!model) {
			return;
		}

		let finalStatus = 'unknown';
		let finalMessage = '';

		try {
			await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('yuvadev.localModel.progressTitle', 'Pulling YuvaDev local model'),
				cancellable: false,
			}, async progress => {
				const response = await requestService.request({
					type: 'POST',
					url: `${apiUrl}/models/pull`,
					headers: { 'Content-Type': 'application/json' },
					data: JSON.stringify({ model: model.trim() }),
				}, CancellationToken.None);

				let buffer = '';
				const handleFrame = (frameText: string) => {
					if (!frameText.trim()) {
						return;
					}
					const frame = JSON.parse(frameText) as {
						status?: string;
						model?: string;
						message?: string;
						progress_pct?: number;
					};
					finalStatus = frame.status === 'ready' ? 'ready' : frame.status === 'error' ? 'error' : finalStatus;
					finalMessage = frame.message ?? finalMessage;
					const percent = typeof frame.progress_pct === 'number' ? Math.max(0, Math.min(100, frame.progress_pct)) : undefined;
					progress.report({
						message: percent !== undefined
							? localize('yuvadev.localModel.progressMessage', '{0} ({1}%)', frame.message ?? 'Pulling model...', percent)
							: frame.message ?? localize('yuvadev.localModel.progressFallback', 'Pulling model...'),
					});
				};

				await new Promise<void>((resolve, reject) => {
					listenStream<VSBuffer>(response.stream, {
						onData: chunk => {
							buffer += chunk.toString();
							const lines = buffer.split('\n');
							buffer = lines.pop() ?? '';
							for (const line of lines) {
								handleFrame(line);
							}
						},
						onError: reject,
						onEnd: () => {
							if (buffer.trim()) {
								handleFrame(buffer);
							}
							resolve();
						},
					});
				});
			});

			if (finalStatus === 'error') {
				throw new Error(finalMessage || localize('yuvadev.localModel.pullFailed', 'The model pull finished with an error.'));
			}

			await configurationService.updateValue(YUVADEV_LOCAL_MODEL_SETTING, model.trim(), ConfigurationTarget.APPLICATION);
			try {
				const payload: ProviderUpdatePayload = { local_model: model.trim() };
				if (getRuntimeMode(configurationService) === 'local') {
					payload.primary_provider = 'ollama';
				}
				await persistRuntimeSelection(accessor, payload);
			} catch (error) {
				notificationService.warn(localize(
					'yuvadev.localModel.backendWarning',
					'Local model was saved in the IDE, but the backend default could not be updated yet: {0}',
					error instanceof Error ? error.message : String(error),
				));
			}

			notificationService.info(localize(
				'yuvadev.localModel.ready',
				'Local model {0} is ready for YuvaDev.',
				model.trim(),
			));
		} catch (error) {
			notificationService.error(localize(
				'yuvadev.localModel.failed',
				'Could not pull the local model: {0}',
				error instanceof Error ? error.message : String(error),
			));
		}
	}
});

class YuvaDevOnboardingContribution {
	static readonly ID = 'workbench.contrib.yuvadevOnboarding';

	constructor(
		@IWalkthroughsService walkthroughsService: IWalkthroughsService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@ICommandService commandService: ICommandService,
	) {
		if (isWeb) {
			return;
		}

		walkthroughsService.registerWalkthrough(createYuvaDevWalkthrough());

		if (!configurationService.getValue<boolean>(YUVADEV_ONBOARDING_OPEN_SETTING)) {
			return;
		}

		if (storageService.getBoolean(YUVADEV_WALKTHROUGH_OPENED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}

		storageService.store(YUVADEV_WALKTHROUGH_OPENED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		void commandService.executeCommand('yuvadev.runOnboardingWizard').catch(() => {
			void commandService.executeCommand('workbench.action.openWalkthrough', YUVADEV_WALKTHROUGH_ID);
		});
	}
}

registerWorkbenchContribution2(YuvaDevOnboardingContribution.ID, YuvaDevOnboardingContribution, WorkbenchPhase.AfterRestored);
