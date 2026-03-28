/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isWeb } from '../../../../base/common/platform.js';
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
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import product from '../../../../platform/product/common/product.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
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
const YUVADEV_ONBOARDING_OPEN_SETTING = 'yuvadev.onboarding.openOnStartup';
const YUVADEV_BACKEND_AUTOSTART_SETTING = 'yuvadev.backend.autoStart';
const YUVADEV_AUTH_ACCESS_TOKEN_SECRET = 'yuvadev.auth.accessToken';
const YUVADEV_AUTH_REFRESH_TOKEN_SECRET = 'yuvadev.auth.refreshToken';
const YUVADEV_AUTH_EMAIL_STORAGE_KEY = 'yuvadev.auth.email';

type RuntimeMode = 'auto' | 'local' | 'cloud' | 'hybrid';
type CloudProvider = 'auto' | 'anthropic' | 'openai' | 'deepseek';

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
	};
}

type ProviderUpdatePayload = {
	anthropic?: string;
	openai?: string;
	deepseek?: string;
	primary_provider?: string;
	local_model?: string;
};

interface AuthTokenResponse {
	access_token: string;
	refresh_token: string;
	token_type: string;
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

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'yuvadev',
	title: localize('yuvadev.configuration.title', 'YuvaDev'),
	type: 'object',
	properties: {
		[YUVADEV_API_URL_SETTING]: {
			type: 'string',
			default: 'http://127.0.0.1:8000',
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
			enum: ['auto', 'anthropic', 'openai', 'deepseek'],
			default: 'auto',
			scope: ConfigurationScope.APPLICATION,
			description: localize('yuvadev.configuration.cloudProvider', 'Preferred cloud provider when YuvaDev is running in cloud mode.'),
		},
		[YUVADEV_LOCAL_MODEL_SETTING]: {
			type: 'string',
			default: 'qwen3:4b',
			scope: ConfigurationScope.APPLICATION_MACHINE,
			description: localize('yuvadev.configuration.localModel', 'Default Ollama model that YuvaDev should use for local runs.'),
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
	return (configured && configured.length > 0 ? configured : 'http://127.0.0.1:8000').replace(/\/+$/, '');
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

function providerLabel(provider: string): string {
	switch (provider) {
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
			label: 'Anthropic Claude',
			description: 'Paid cloud',
			detail: 'Use Claude models with your Anthropic key.',
			value: 'anthropic',
		},
		{
			label: 'OpenAI GPT',
			description: 'Paid cloud',
			detail: 'Use GPT models with your OpenAI key.',
			value: 'openai',
		},
		{
			label: 'DeepSeek',
			description: 'Paid cloud',
			detail: 'Use DeepSeek models with your DeepSeek key.',
			value: 'deepseek',
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
		description: localize('yuvadev.walkthrough.description', 'Choose local or cloud execution, connect providers, and get your first model ready.'),
		order: 2_000,
		source: product.nameShort,
		isFeatured: true,
		when: ContextKeyExpr.not('isWeb'),
		icon: { type: 'icon', icon: Codicon.rocket },
		walkthroughPageTitle: localize('yuvadev.walkthrough.pageTitle', 'Set up YuvaDev IDE'),
		steps: [
			{
				id: 'yuvadev.runtimeMode',
				title: localize('yuvadev.walkthrough.runtime.title', 'Choose local, cloud, or hybrid mode'),
				description: localize('yuvadev.walkthrough.runtime.description', 'Tell YuvaDev whether to prefer local Ollama, a paid cloud provider, or automatic fallback.\n[Choose Runtime Mode](command:yuvadev.chooseRuntimeMode)'),
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
				title: localize('yuvadev.walkthrough.provider.title', 'Connect a cloud provider'),
				description: localize('yuvadev.walkthrough.provider.description', 'Add an Anthropic, OpenAI, or DeepSeek key so YuvaDev can run paid cloud sessions inside the IDE.\n[Add Provider Key](command:yuvadev.configureProviderKey)'),
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
				description: localize('yuvadev.walkthrough.account.description', 'Sign in for cloud entitlements, paid routing, and account-linked workspace sessions.\n[Sign In](command:yuvadev.signInAccount)\n[Check Account Status](command:yuvadev.checkAccountStatus)'),
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
		placeHolder: localize('yuvadev.cloudProvider.placeholder', 'Choose the cloud provider YuvaDev should prefer'),
	});
	return picked?.value;
}

function formEncode(data: Record<string, string>): string {
	return Object.entries(data)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join('&');
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

async function fetchYuvaDevProfile(
	configurationService: IConfigurationService,
	requestService: IRequestService,
	secretStorageService: ISecretStorageService,
): Promise<AuthUserProfile> {
	const tokens = await readAuthTokens(secretStorageService);
	let accessToken = tokens.accessToken;

	if (!accessToken) {
		accessToken = await refreshYuvaDevAccessToken(configurationService, requestService, secretStorageService);
	}

	if (!accessToken) {
		throw new Error(localize('yuvadev.auth.notSignedIn', 'No active YuvaDev account session found.'));
	}

	try {
		return await requestJson<AuthUserProfile>(
			requestService,
			`${getApiUrl(configurationService)}/api/auth/me`,
			{ headers: { Authorization: `Bearer ${accessToken}` } },
		);
	} catch {
		const refreshedAccess = await refreshYuvaDevAccessToken(configurationService, requestService, secretStorageService);
		if (!refreshedAccess) {
			throw new Error(localize('yuvadev.auth.sessionExpired', 'Your YuvaDev session expired. Please sign in again.'));
		}

		return requestJson<AuthUserProfile>(
			requestService,
			`${getApiUrl(configurationService)}/api/auth/me`,
			{ headers: { Authorization: `Bearer ${refreshedAccess}` } },
		);
	}
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
			localize('yuvadev.wizard.start.detail', 'Run the full setup now: runtime mode, language, health checks, providers, local model, and account sign-in.'),
		);

		if (!shouldStart) {
			await commandService.executeCommand('workbench.action.openWalkthrough', YUVADEV_WALKTHROUGH_ID);
			return;
		}

		await commandService.executeCommand('yuvadev.chooseRuntimeMode');
		await commandService.executeCommand('yuvadev.chooseLanguage');
		await commandService.executeCommand('yuvadev.checkBackendHealth');

		const runtimeMode = getRuntimeMode(configurationService);

		if (runtimeMode !== 'local') {
			const shouldConfigureCloud = await confirmWizardStep(
				quickInputService,
				localize('yuvadev.wizard.cloud.title', 'Configure Cloud Provider'),
				localize('yuvadev.wizard.cloud.detail', 'Connect Anthropic, OpenAI, or DeepSeek for paid cloud execution.'),
			);
			if (shouldConfigureCloud) {
				await commandService.executeCommand('yuvadev.configureProviderKey');
			}
		}

		if (runtimeMode !== 'cloud') {
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
		const requestService = accessor.get(IRequestService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const storageService = accessor.get(IStorageService);
		const secretStorageService = accessor.get(ISecretStorageService);

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

		const password = await quickInputService.input({
			title: localize('yuvadev.auth.password.title', 'YuvaDev Account Password'),
			prompt: localize('yuvadev.auth.password.prompt', 'Enter your account password.'),
			password: true,
			validateInput: async value => value.trim().length > 0 ? undefined : localize('yuvadev.auth.password.required', 'Password is required.'),
		});

		if (!password) {
			return;
		}

		try {
			const tokenResponse = await progressService.withProgress<AuthTokenResponse>({
				location: ProgressLocation.Notification,
				title: localize('yuvadev.auth.signingIn', 'Signing in to YuvaDev account'),
				cancellable: false,
			}, async () => requestJson<AuthTokenResponse>(
				requestService,
				`${getApiUrl(configurationService)}/api/auth/login`,
				{
					type: 'POST',
					data: formEncode({
						username: email.trim(),
						password: password,
						grant_type: 'password',
					}),
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				},
			));

			await Promise.all([
				secretStorageService.set(YUVADEV_AUTH_ACCESS_TOKEN_SECRET, tokenResponse.access_token),
				secretStorageService.set(YUVADEV_AUTH_REFRESH_TOKEN_SECRET, tokenResponse.refresh_token),
			]);
			storageService.store(YUVADEV_AUTH_EMAIL_STORAGE_KEY, email.trim(), StorageScope.APPLICATION, StorageTarget.USER);

			const profile = await fetchYuvaDevProfile(configurationService, requestService, secretStorageService);
			notificationService.info(localize(
				'yuvadev.auth.login.success',
				'Signed in as {0}. Account is active and ready for cloud-enabled YuvaDev sessions.',
				profile.email,
			));
		} catch (error) {
			await clearAuthTokens(secretStorageService);
			notificationService.error(localize(
				'yuvadev.auth.login.failed',
				'YuvaDev sign-in failed: {0}',
				error instanceof Error ? error.message : String(error),
			));
		}
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
		const secretStorageService = accessor.get(ISecretStorageService);
		const notificationService = accessor.get(INotificationService);

		await clearAuthTokens(secretStorageService);
		notificationService.info(localize('yuvadev.auth.signOut.complete', 'Signed out from YuvaDev account on this device.'));
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

		const currentMode = getRuntimeMode(configurationService);
		const picked = await quickInputService.pick<ValueQuickPickItem<RuntimeMode>>([
			{
				label: 'Auto',
				description: 'Balanced default',
				detail: 'Let YuvaDev choose the best available path from your configured providers.',
				value: 'auto',
				picked: currentMode === 'auto',
			},
			{
				label: 'Local',
				description: 'Free on-device',
				detail: 'Prefer your local Ollama model and keep work on the machine when possible.',
				value: 'local',
				picked: currentMode === 'local',
			},
			{
				label: 'Cloud',
				description: 'Paid provider',
				detail: 'Force YuvaDev to use your selected cloud provider for generation.',
				value: 'cloud',
				picked: currentMode === 'cloud',
			},
			{
				label: 'Hybrid',
				description: 'Best of both',
				detail: 'Keep auto-routing available while still configuring local and cloud paths.',
				value: 'hybrid',
				picked: currentMode === 'hybrid',
			},
		], {
			placeHolder: localize('yuvadev.runtimeMode.placeholder', 'Choose how YuvaDev should execute tasks'),
		});

		if (!picked) {
			return;
		}

		await configurationService.updateValue(YUVADEV_RUNTIME_MODE_SETTING, picked.value, ConfigurationTarget.APPLICATION);

		try {
			if (picked.value === 'local') {
				await persistRuntimeSelection(accessor, { primary_provider: 'ollama' });
			} else if (picked.value === 'cloud') {
				let provider = getCloudProvider(configurationService);
				if (provider === 'auto') {
					provider = await promptForCloudProvider(quickInputService, provider) ?? 'auto';
					if (provider !== 'auto') {
						await configurationService.updateValue(YUVADEV_CLOUD_PROVIDER_SETTING, provider, ConfigurationTarget.APPLICATION);
					}
				}
				if (provider !== 'auto') {
					await persistRuntimeSelection(accessor, { primary_provider: provider });
				}
			} else {
				await persistRuntimeSelection(accessor, { primary_provider: 'auto' });
			}
		} catch (error) {
			notificationService.warn(localize(
				'yuvadev.runtimeMode.backendWarning',
				'Runtime mode was saved in the IDE, but the backend could not be updated yet: {0}',
				error instanceof Error ? error.message : String(error),
			));
		}

		notificationService.info(localize(
			'yuvadev.runtimeMode.updated',
			'YuvaDev runtime mode set to {0}.',
			picked.label,
		));
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

		if (getRuntimeMode(configurationService) === 'cloud') {
			try {
				await persistRuntimeSelection(accessor, { primary_provider: provider });
			} catch (error) {
				notificationService.warn(localize(
					'yuvadev.cloudProvider.backendWarning',
					'Cloud provider was saved in the IDE, but the backend could not be updated yet: {0}',
					error instanceof Error ? error.message : String(error),
				));
			}
		}

		notificationService.info(localize(
			'yuvadev.cloudProvider.updated',
			'YuvaDev cloud provider set to {0}.',
			providerLabel(provider),
		));
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
		const notificationService = accessor.get(INotificationService);
		const currentProvider = getCloudProvider(configurationService);
		const provider = await promptForCloudProvider(quickInputService, currentProvider);

		if (!provider) {
			return;
		}

		const apiKey = await quickInputService.input({
			title: localize('yuvadev.providerKey.title', 'Add Cloud Provider Key'),
			prompt: localize('yuvadev.providerKey.prompt', 'Paste your {0} API key. The value will be stored by the YuvaDev backend.', providerLabel(provider)),
			placeHolder: localize('yuvadev.providerKey.placeholder', 'sk-...'),
			password: true,
			validateInput: async value => value.trim().length > 0 ? undefined : localize('yuvadev.providerKey.required', 'API key is required.'),
		});

		if (!apiKey) {
			return;
		}

		await configurationService.updateValue(YUVADEV_CLOUD_PROVIDER_SETTING, provider, ConfigurationTarget.APPLICATION);

		const payload: ProviderUpdatePayload = { [provider]: apiKey.trim() };
		if (getRuntimeMode(configurationService) === 'cloud') {
			payload.primary_provider = provider;
		}

		try {
			await persistRuntimeSelection(accessor, payload);
			notificationService.info(localize(
				'yuvadev.providerKey.saved',
				'{0} key saved. YuvaDev can now use that cloud provider.',
				providerLabel(provider),
			));
		} catch (error) {
			notificationService.error(localize(
				'yuvadev.providerKey.failed',
				'Could not save the provider key: {0}',
				error instanceof Error ? error.message : String(error),
			));
		}
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
