/**
 * extension.ts — YuvaDev AI IDE Extension Entry Point
 *
 * This file is intentionally thin. All business logic lives in:
 *   services/  — OllamaService, BackendService, HealthService
 *   ui/        — ChatViewProvider, HubViewProvider, StatusBar
 *
 * Key fixes vs. original 759-line god-object:
 *   - Backend no longer unconditionally starts Ollama for cloud providers
 *   - yuvadev-ai.applyCode is a proper registered command with selection-aware behavior
 *   - Quick actions route through chat panel (not a nonexistent REST endpoint)
 *   - explainCode routes through chat panel (not a broken standalone WS)
 */

import * as vscode from 'vscode';
import * as path from 'path';

import { ChatViewProvider } from './ui/chat/ChatViewProvider';
import { HubViewProvider } from './ui/hub/HubViewProvider';
import { ProfileManager } from './utils/ProfileManager';
import { YuvaDevStatusBar } from './ui/statusBar';
import { PlanVisualizationPanel } from './ui/planPanel';
import { ConfidenceDiffPanel } from './ui/diffPanel';
import { OllamaService } from './services/OllamaService';
import { BackendService } from './services/BackendService';
import { BackendProcess } from './services/BackendProcess';
import { AgentLoopService } from './services/AgentLoopService';
import { AgentApprovalHandler } from './services/AgentApprovalHandler';
import { AgentActivityPanel } from './ui/agent/AgentActivityPanel';
import { AgentWorkspaceView } from './ui/agent/AgentWorkspaceView';
import { ArtifactStore } from './services/ArtifactStore';
import { KeychainService } from './services/KeychainService';
import { BackendClient } from './services/BackendClient';
import { SettingsPanel } from './ui/SettingsPanel';
import { OnboardingPanel } from './panels/OnboardingPanel';
import { AgentPanel } from './panels/AgentPanel';
import { DiffPreviewService } from './services/DiffPreviewService';
import { UpdateChecker } from './services/UpdateChecker';
import { LoginPanel } from './panels/LoginPanel';
import { PluginsPanel } from './panels/PluginsPanel';
import { HistoryPanelProvider } from './panels/HistoryPanel';
import { AgentCodeLensProvider } from './ui/agentCodeLens';

const BACKEND_PORT = 8125;

async function checkBackendHealth(): Promise<boolean> {
    try {
        const res = await fetch(`http://localhost:${BACKEND_PORT}/health`, {
            signal: AbortSignal.timeout(2000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

function resolveBackendLaunchDir(): string | undefined {
    const configured = vscode.workspace.getConfiguration('yuvadev').get<string>('backendPath')?.trim();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const candidates = [
        configured,
        workspaceFolder ? path.join(workspaceFolder, 'yuvadev-backend') : undefined,
        workspaceFolder ? path.join(workspaceFolder, '..', 'yuvadev-backend') : undefined,
        workspaceFolder,
    ].filter((candidate): candidate is string => Boolean(candidate));

    return candidates.find((candidate) => {
        try {
            return require('fs').existsSync(path.join(candidate, 'main.py'));
        } catch {
            return false;
        }
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// Activation
// ─────────────────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // ── Core services ─────────────────────────────────────────────────
    ProfileManager.initialize(context);
    const ollamaService = new OllamaService();
    const backendService = new BackendService(context, ollamaService);
    const backendProcess = new BackendProcess();
    const agentLoopService = new AgentLoopService(context);
    const approvalHandler = new AgentApprovalHandler();

    // ── Key management ────────────────────────────────────────────────
    const keychain = new KeychainService(context.secrets);
    const backendClient = new BackendClient(keychain);
    const agentPanel = new AgentPanel(context, backendClient, keychain, ollamaService);
    const diffPreviewService = new DiffPreviewService(backendClient);
    let logoutRequested = false;

    context.subscriptions.push({
        dispose: () => {
            if (!logoutRequested) {
                return;
            }
            void keychain.clearAllProviderKeys();
            void keychain.clearCloudSession();
        },
    });

    // ── Context keys used by keybindings ─────────────────────────────
    void vscode.commands.executeCommand('setContext', 'yuvadev.agentRunning', false);
    void vscode.commands.executeCommand('setContext', 'yuvadev.pendingApproval', false);
    void vscode.commands.executeCommand('setContext', 'yuvadev.hasPendingChanges', false);

    // ── UI singletons ───────────────────────────────────────────────
    const statusBar = new YuvaDevStatusBar(context);
    statusBar.setStatus('offline');

    backendClient.setUnauthorizedHandler(async () => {
        LoginPanel.show(context, backendClient, keychain, async (email) => {
            statusBar.setAccountEmail(email);
        });
    });

    void (async () => {
        const savedEmail = await keychain.getAccountEmail();
        if (savedEmail) {
            statusBar.setAccountEmail(savedEmail);
            return;
        }

        const accessToken = await keychain.getAccessToken();
        if (!accessToken) {
            return;
        }

        const user = await backendClient.getCurrentUser();
        if (user?.email) {
            await keychain.storeAccountEmail(user.email);
            statusBar.setAccountEmail(user.email);
        }
    })();

    const diffPanel = new ConfidenceDiffPanel(context);
    context.subscriptions.push(diffPanel);

    // ── Hub view ─────────────────────────────────────────────────────
    const hubProvider = new HubViewProvider(context, backendService);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(HubViewProvider.viewType, hubProvider)
    );

    // ── Chat view ───────────────────────────────────────────────────
    const chatProvider = new ChatViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider)
    );

    // ── Agent Activity sidebar view ─────────────────────────────────
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AgentPanel.viewType, agentPanel)
    );

    // ── Agent History sidebar view ──────────────────────────────────
    const historyProvider = new HistoryPanelProvider(backendClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(HistoryPanelProvider.viewType, historyProvider)
    );

    // ── CodeLenses ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(['python', 'typescript', 'javascript'], new AgentCodeLensProvider())
    );

    ollamaService.onStatusChange(status => hubProvider.setOllamaStatus(status));

    // NOTE: We do NOT probe Ollama on activation — the status indicator should
    // only turn green when the user explicitly clicks "Start Backend".
    // Auto-probing caused Ollama to always appear "online" on every window open.

    const startBackendWithProgress = async (forceRestart = false): Promise<boolean> => {
        if (forceRestart) {
            backendProcess.stop();
        }

        statusBar.setStatus('starting');
        hubProvider.setStatus('starting');

        const ok = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Starting YuvaDev backend...',
            cancellable: false,
        }, async () => backendProcess.start(context));

        if (ok) {
            statusBar.setStatus('online');
            hubProvider.setStatus('online');
            return true;
        }

        statusBar.setStatus('offline');
        hubProvider.setStatus('offline');
        vscode.window.showErrorMessage('YuvaDev backend failed to start. Check Output panel.');
        return false;
    };

    const stopBackendProcess = (): void => {
        backendProcess.stop();
        statusBar.setStatus('offline');
        hubProvider.setStatus('offline');
    };

    context.subscriptions.push({
        dispose: () => stopBackendProcess(),
    });

    // ── AI Workspace (Phase 4 — permanent 3-tab sidebar) ──────────────────
    const artifactStore = new ArtifactStore(context.workspaceState);
    const workspaceView = new AgentWorkspaceView(context, artifactStore);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AgentWorkspaceView.viewType, workspaceView)
    );
    context.subscriptions.push(workspaceView);
    // Inject into the Phase 3 shim so existing call sites work unchanged
    AgentActivityPanel.init(workspaceView);

    // ── Commands ──────────────────────────────────────────────────────
    _registerCommands(
        context,
        chatProvider,
        agentLoopService,
        approvalHandler,
        workspaceView,
        keychain,
        backendClient,
        agentPanel,
        diffPreviewService,
        statusBar,
        () => {
            logoutRequested = true;
        },
        startBackendWithProgress,
        stopBackendProcess,
    );

    if (await checkBackendHealth()) {
        statusBar.setStatus('online');
        hubProvider.setStatus('online');
    } else {
        await startBackendWithProgress(false);
    }

    // ── Background services ───────────────────────────────────────────
    context.subscriptions.push(backendService);
    context.subscriptions.push(agentLoopService);
    context.subscriptions.push(approvalHandler);
    context.subscriptions.push(diffPreviewService);

    // ── Session recovery: reconnect to any running agent loop ────────────
    agentLoopService.recoverSession().then(recovered => {
        if (!recovered) { return; }
        vscode.window.showInformationMessage(
            `YuvaDev: Reconnecting to active agent session "${recovered.task}"`,
            'Open Panel',
        ).then(pick => {
            if (pick === 'Open Panel') {
                vscode.commands.executeCommand('yuvadev-ai.runAgentTask', recovered);
            }
        });
    });

    // ── First-launch onboarding wizard ───────────────────────────────
    if (!context.globalState.get<boolean>('yuvadev.setupComplete')) {
        OnboardingPanel.show(context, keychain, backendClient);
    }

    // ── Auto-show chat ─────────────────────────────────────────────────
    const cfg = vscode.workspace.getConfiguration('yuvadev');
    if (cfg.get<boolean>('showChatOnStartup', true)) {
        vscode.commands.executeCommand('workbench.view.extension.yuvadev-ai-sidebar');
    }

    // ── Daily update check (private release feed) ──────────────────────
    void (async () => {
        const checker = new UpdateChecker();
        const extensionVersion = String(context.extension.packageJSON?.version ?? '0.0.0').replace(/^v/, '');
        const lastCheck = context.globalState.get<number>('yuvadev.lastUpdateCheck', 0);
        const oneDayMs = 86_400_000;

        if (Date.now() - lastCheck <= oneDayMs) {
            return;
        }

        await context.globalState.update('yuvadev.lastUpdateCheck', Date.now());
        const update = await checker.checkForUpdate(extensionVersion);
        if (!update?.available) {
            return;
        }

        const choice = await vscode.window.showInformationMessage(
            `YuvaDev ${update.version} is available.`,
            'Download update',
            'Later',
        );

        if (choice === 'Download update' && update.downloadUrl) {
            await vscode.env.openExternal(vscode.Uri.parse(update.downloadUrl));
        }
    })();
}

export function deactivate(): void { /* services disposed via context.subscriptions */ }

// ─────────────────────────────────────────────────────────────────────────────
// Command registration — one place, no surprises
// ─────────────────────────────────────────────────────────────────────────────

function _registerCommands(
    context: vscode.ExtensionContext,
    chat: ChatViewProvider,
    agentLoop: AgentLoopService,
    approvalHandler: AgentApprovalHandler,
    workspaceView: AgentWorkspaceView,
    keychain: KeychainService,
    backendClient: BackendClient,
    agentPanel: AgentPanel,
    diffPreviewService: DiffPreviewService,
    statusBar: YuvaDevStatusBar,
    markLogoutRequested: () => void,
    startBackend: (forceRestart?: boolean) => Promise<boolean>,
    stopBackend: () => void,
): void {
    const reg = (...d: vscode.Disposable[]) => context.subscriptions.push(...d);

    // ── Settings panel ────────────────────────────────────────────────────────
    reg(
        vscode.commands.registerCommand('yuvadev-ai.openSettings', () => {
            SettingsPanel.show(context, keychain, backendClient);
        }),
        vscode.commands.registerCommand('yuvadev-ai.openWorkspace', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.yuvadev-ai-workspace-panel');
            await vscode.commands.executeCommand('yuvadev-ai.workspaceView.focus');
        }),
        vscode.commands.registerCommand('yuvadev-ai.improveFunction', async (functionName: string, fileName: string) => {
            const text = `/edit Improve the function ${functionName} in ${fileName}`;
            await vscode.commands.executeCommand('yuvadev-ai.cmdK', text);
        })
    );

    reg(
        vscode.commands.registerCommand('yuvadev.openSettings', () => {
            SettingsPanel.show(context, keychain, backendClient);
        }),
        vscode.commands.registerCommand('yuvadev.showLogin', () => {
            LoginPanel.show(context, backendClient, keychain, async (email) => {
                statusBar.setAccountEmail(email);
            });
        }),
        vscode.commands.registerCommand('yuvadev.logout', async () => {
            markLogoutRequested();
            try {
                await backendClient.logout();
            } catch {
                await keychain.clearAllProviderKeys();
                await keychain.clearCloudSession();
            }
            statusBar.setAccountEmail(null);
            vscode.window.showInformationMessage('Signed out of YuvaDev Cloud and cleared stored API keys.');
        }),
        vscode.commands.registerCommand('yuvadev.restart', async () => {
            const ok = await startBackend(true);
            if (!ok) {
                vscode.window.showErrorMessage(
                    'YuvaDev backend failed to start. Check Output panel for diagnostics.',
                );
            }
        }),
        vscode.commands.registerCommand('yuvadev.showOnboarding', () => {
            OnboardingPanel.show(context, keychain, backendClient);
        }),
        vscode.commands.registerCommand('yuvadev.openPlugins', () => {
            PluginsPanel.show(context, backendClient);
        }),
        vscode.commands.registerCommand('yuvadev.triggerAgent', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.yuvadev');
            const taskFromInput = agentPanel.getTaskInput().trim();
            if (taskFromInput) {
                await agentPanel.startAgent(taskFromInput);
                return;
            }
            const fallback = await vscode.window.showInputBox({
                placeHolder: 'Describe what you want YuvaDev to build...',
                prompt: 'YuvaDev Agent Task',
                ignoreFocusOut: true,
            });
            if (fallback?.trim()) {
                await agentPanel.startAgent(fallback.trim());
            }
        }),
        vscode.commands.registerCommand('yuvadev.approveAction', () => agentPanel.approve()),
        vscode.commands.registerCommand('yuvadev.rejectAction', () => agentPanel.reject()),
        vscode.commands.registerCommand('yuvadev.stopAgent', () => agentPanel.stop()),
        vscode.commands.registerCommand('yuvadev.showDiffPreview', async (sessionId?: string) => {
            const resolvedSessionId =
                (typeof sessionId === 'string' && sessionId) ||
                agentPanel.currentSessionId ||
                agentLoop.currentSession?.sessionId;

            if (!resolvedSessionId) {
                vscode.window.showWarningMessage('YuvaDev: No active session with pending changes.');
                return;
            }

            try {
                const committed = await diffPreviewService.showDiffAndCommit(resolvedSessionId);
                if (committed) {
                    agentPanel.clearCommittedSession(resolvedSessionId);
                    void vscode.commands.executeCommand('setContext', 'yuvadev.hasPendingChanges', false);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`YuvaDev: ${err.message ?? 'Failed to review pending changes.'}`);
            }
        }),
    );

    // Backend lifecycle
    reg(
        vscode.commands.registerCommand('yuvadev-ai.startBackend', async () => {
            await startBackend(false);
        }),
        vscode.commands.registerCommand('yuvadev-ai.stopBackend', () => stopBackend()),
    );

    // Apply code — registered VS Code command so any handler can call it
    // FIX: old implementation always did full-file replace (destructive for snippets)
    reg(
        vscode.commands.registerCommand(
            'yuvadev-ai.applyCode',
            async (code: string, replaceFullFile = false) => {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage(
                        'YuvaDev: Open a file in the editor before applying code.'
                    );
                    return;
                }
                await editor.edit(eb => {
                    if (replaceFullFile) {
                        // /edit mode: replace entire file with LLM output
                        const fullRange = new vscode.Range(
                            editor.document.positionAt(0),
                            editor.document.positionAt(editor.document.getText().length),
                        );
                        eb.replace(fullRange, code);
                    } else if (!editor.selection.isEmpty) {
                        // Replace the highlighted selection
                        eb.replace(editor.selection, code);
                    } else {
                        // No selection: insert at cursor
                        eb.insert(editor.selection.active, code);
                    }
                });
                await editor.document.save();
                vscode.window.showInformationMessage(
                    `YuvaDev applied changes to ${path.basename(editor.document.fileName)}`
                );
            }
        )
    );

    reg(
        vscode.commands.registerCommand('yuvadev-ai.openHub', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.yuvadev-ai-sidebar');
            await vscode.commands.executeCommand('yuvadev-ai.hubView.focus');
        })
    );

    // Chat panel toggle
    reg(
        vscode.commands.registerCommand('yuvadev-ai.toggleChat', () =>
            vscode.commands.executeCommand('workbench.view.extension.yuvadev-ai-sidebar')
        )
    );

    // Plan panel
    reg(
        vscode.commands.registerCommand('yuvadev-ai.showPlanPanel', () =>
            PlanVisualizationPanel.show(context)
        )
    );

    // Cmd+K
    reg(
        vscode.commands.registerCommand('yuvadev-ai.cmdK', async (prefill?: string) => {
            const input = prefill || await vscode.window.showInputBox({
                placeHolder: 'Tell YuvaDev what to do\u2026',
                prompt: 'Universal AI Execution',
            });
            if (input) {
                await _focusChat();
                chat.sendExternalMessage(input);
            }
        })
    );

    // Quick actions — FIX: all now route through chat panel
    const quickActions: { cmd: string; prompt: string }[] = [
        { cmd: 'askAI', prompt: 'Explain this code or help me with it:\n\n' },
        { cmd: 'refactor', prompt: '/edit Refactor this code to be cleaner and more efficient:\n\n' },
        { cmd: 'generateApp', prompt: '/agent Scaffold a complete application with best practices.' },
        { cmd: 'fixErrors', prompt: '/edit Fix all bugs and syntax errors in this code:\n\n' },
        { cmd: 'addTests', prompt: '/edit Write comprehensive unit tests for this code:\n\n' },
        { cmd: 'explainCode', prompt: 'Explain how this code works step by step:\n\n' },
    ];
    quickActions.forEach(({ cmd, prompt }) => {
        reg(vscode.commands.registerCommand(`yuvadev-ai.${cmd}`, async () => {
            await _focusChat();
            const editor = vscode.window.activeTextEditor;
            let ctx = '';
            if (editor && !editor.selection.isEmpty) {
                const lang = editor.document.languageId;
                ctx = `\`\`\`${lang}\n${editor.document.getText(editor.selection)}\n\`\`\``;
            }
            chat.sendExternalMessage(prompt + ctx);
        }));
    });

    // ── Phase 3: Agent Loop ───────────────────────────────────────────────────
    reg(
        vscode.commands.registerCommand(
            'yuvadev-ai.runAgentTask',
            async (recoveredSession?: { sessionId: string; task: string; workspace: string }) => {
                const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
                let task: string;
                let sessionId: string;

                if (recoveredSession) {
                    // Recovery path: reconnect to existing session
                    task = recoveredSession.task;
                    sessionId = recoveredSession.sessionId;
                } else {
                    // Normal path: prompt for new task
                    const input = await vscode.window.showInputBox({
                        placeHolder: 'Describe what you want the agent to do…',
                        prompt: 'Agent Task — YuvaDev will autonomously execute this',
                        ignoreFocusOut: true,
                    });
                    if (!input) { return; }
                    task = input;
                    try {
                        sessionId = await agentLoop.startSession(task, workspace);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`YuvaDev: failed to start agent session: ${err.message}`);
                        return;
                    }
                }

                // Open the activity panel
                const panel = AgentActivityPanel.show(
                    context,
                    // onApprove
                    async (sid, approvalId, decision, msg) => {
                        try {
                            await agentLoop.approve(sid, approvalId, decision, msg);
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Approval failed: ${err.message}`);
                        }
                    },
                    // onStop
                    async (sid) => {
                        await agentLoop.stopLoop(sid);
                    },
                );

                panel.setSession(sessionId, task);

                // Subscribe to stream events from AgentLoopService
                agentLoop.removeAllListeners('event');
                agentLoop.removeAllListeners('error');
                agentLoop.on('event', (evt) => {
                    panel.pushEvent(evt);
                    // Also handle approval_required events via native vscode.diff
                    if (evt.type === 'approval_required') {
                        approvalHandler.handleApproval(evt, agentLoop, sessionId).catch(
                            (err) => vscode.window.showErrorMessage(`Approval error: ${err.message}`)
                        );
                    }
                });
                agentLoop.on('error', (err) => {
                    vscode.window.showErrorMessage(`YuvaDev Agent error: ${err.message}`);
                });

                // Connect WebSocket stream
                agentLoop.connectStream(sessionId);
            }
        )
    );

    // Multi-agent dashboard
    reg(
        vscode.commands.registerCommand('yuvadev-ai.openAgentDashboard', () =>
            vscode.commands.executeCommand('yuvadev-ai.runAgentTask')
        )
    );

    // ── Phase 7: Multi-Agent Orchestration ───────────────────────────────────
    reg(
        vscode.commands.registerCommand(
            'yuvadev-ai.runOrchestrateTask',
            async () => {
                const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '.';
                const input = await vscode.window.showInputBox({
                    placeHolder: 'Describe the high-level task to orchestrate…',
                    prompt: 'Multi-Agent Orchestration — Planner → Coder → Reviewer → Tester',
                    ignoreFocusOut: true,
                });
                if (!input) { return; }

                // 1. POST /orchestrate to create a session
                let sessionId: string;
                try {
                    sessionId = await agentLoop.startOrchestrateSession(input, workspace);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`YuvaDev: orchestration failed: ${err.message}`);
                    return;
                }

                // 2. Show Plan Panel
                const planPanel = PlanVisualizationPanel.show(context);

                // 3. Open Activity Panel
                const actPanel = AgentActivityPanel.show(
                    context,
                    async (sid, approvalId, decision, msg) => {
                        try { await agentLoop.approve(sid, approvalId, decision, msg); }
                        catch (err: any) { vscode.window.showErrorMessage(`Approval failed: ${err.message}`); }
                    },
                    async (sid) => { await agentLoop.stopLoop(sid); },
                );
                actPanel.setSession(sessionId, `[ORCH] ${input}`);

                // 4. Subscribe to stream events
                agentLoop.removeAllListeners('event');
                agentLoop.on('event', (evt) => {
                    actPanel.pushEvent(evt);
                    const data = evt.data || {};

                    // Route plan to Plan Panel
                    if (data.event_type === 'plan_approval' && data.plan) {
                        planPanel.postOrchestratorPlan(data.plan);
                    }

                    // Live subtask status updates
                    if (data.subtask_id && data.agent_role) {
                        const orchEvt = data._orchestrator_event || '';
                        if (orchEvt === 'SUBTASK_START') {
                            planPanel.updateStepStatus(data.subtask_id, 'in_progress');
                            planPanel.setActiveRole(data.subtask_id, data.agent_role);
                        } else if (orchEvt === 'SUBTASK_DONE') {
                            planPanel.updateStepStatus(data.subtask_id, 'done');
                        } else if (orchEvt === 'REPLAN') {
                            planPanel.updateStepStatus(data.subtask_id, 'failed');
                        }
                    }

                    if (evt.type === 'approval_required') {
                        approvalHandler.handleApproval(evt, agentLoop, sessionId).catch(
                            (err) => vscode.window.showErrorMessage(`Approval error: ${err.message}`)
                        );
                    }
                });
                agentLoop.on('error', (err) => {
                    vscode.window.showErrorMessage(`YuvaDev Orchestration error: ${err.message}`);
                });

                // 5. Connect WebSocket to orchestrator stream
                agentLoop.connectStream(sessionId, /* useOrchStream */ true);
            }
        )
    );

    // Account settings
    reg(
        vscode.commands.registerCommand('yuvadev-ai.openAccountSettings', () =>
            _openAccountSettings(context)
        )
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

async function _focusChat(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.yuvadev-ai-sidebar');
    await vscode.commands.executeCommand('yuvadev-ai.chatView.focus');
}

function _openAgentDashboard(context: vscode.ExtensionContext, ipcToken: string): void {
    const panel = vscode.window.createWebviewPanel(
        'agentDashboard', 'YuvaDev Agent Dashboard',
        vscode.ViewColumn.Two, { enableScripts: true },
    );
    panel.webview.html = _agentHtml();
    panel.webview.onDidReceiveMessage(message => {
        if (message.command !== 'runTask') { return; }
        const wsUrl = 'ws://127.0.0.1:8125/api/v3/agent/ws/agent/run';
        const headers: Record<string, string> = {
            'origin': 'vscode-webview://',
            'x-yuvadev-token': ipcToken,
        };
        let ws: any;
        try { ws = new (require('ws'))(wsUrl, { headers }); } catch (_) {
            panel.webview.postMessage({ type: 'agent_frame', agent: 'System', status: 'ws module unavailable' });
            return;
        }
        ws.on('open', () => ws.send(JSON.stringify({
            task: message.text,
            workspace_root: vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '/tmp',
            mode: 'refactor',
        })));
        ws.on('message', (data: any) => {
            try { panel.webview.postMessage(JSON.parse(data.toString())); } catch (_) { }
        });
        ws.on('error', () =>
            panel.webview.postMessage({ type: 'agent_frame', agent: 'System', status: 'Backend not reachable' })
        );
    }, undefined, context.subscriptions);
}

function _openAccountSettings(context: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
        'yuvadevAccount', 'YuvaDev Account', vscode.ViewColumn.One, { enableScripts: true }
    );
    panel.webview.html = _accountHtml();
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command !== 'login') { return; }
        try {
            const res = await fetch('http://127.0.0.1:8125/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: msg.email, password: msg.password }),
            });
            if (res.ok) {
                const data = await res.json();
                vscode.window.showInformationMessage(`Logged in! Plan: \${data.plan}`);
                panel.webview.postMessage({ type: 'loginSuccess', plan: data.plan });
            } else {
                vscode.window.showErrorMessage('Login failed. Check your credentials.');
            }
        } catch {
            vscode.window.showErrorMessage('Cannot reach YuvaDev backend on port 8125.');
        }
    }, undefined, context.subscriptions);
}

function _agentHtml(): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Agent Dashboard</title>
<style>body{font-family:var(--vscode-font-family);padding:10px;color:var(--vscode-foreground)}
#logs{margin-top:15px;background:rgba(0,0,0,.1);padding:10px;border-radius:5px;height:300px;overflow-y:auto}
.log-entry{margin-bottom:5px;border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:5px}
.agent-Planner{color:#a371f7}.agent-Coder{color:#3fb950}.agent-Reviewer{color:#58a6ff}
.agent-Debugger{color:#f85149}.agent-System{color:#8b949e}
textarea{width:100%;height:80px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
button{margin-top:10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 15px;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}</style></head><body>
<h2>Multi-Agent Orchestrator</h2>
<textarea id="taskInput" placeholder="Enter an autonomous task\u2026"></textarea>
<button onclick="submitTask()">Run Agents</button>
<div id="logs"></div>
<script>
const vscode=acquireVsCodeApi(),logsDiv=document.getElementById('logs');
function submitTask(){const text=document.getElementById('taskInput').value;
  vscode.postMessage({command:'runTask',text});
  logsDiv.innerHTML='<div class="log-entry agent-System">[System] Dispatching task\u2026</div>';}
window.addEventListener('message',event=>{const msg=event.data;
  if(msg.type==='agent_frame'){const el=document.createElement('div');
    el.className='log-entry agent-'+msg.agent;
    el.textContent='['+msg.agent+'] '+msg.status+(msg.action?' \u2192 '+msg.action:'');
    logsDiv.appendChild(el);logsDiv.scrollTop=logsDiv.scrollHeight;}});
</script></body></html>`;
}

function _accountHtml(): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>YuvaDev Account</title>
<style>body{font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);max-width:400px}
input{width:100%;padding:8px;margin:10px 0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
button{width:100%;padding:10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
#status{margin-top:15px;padding:10px;background:rgba(0,0,0,.1);border-radius:4px;display:none}</style></head><body>
<h2>YuvaDev Cloud Authentication</h2>
<p>Sign in to sync your memory and unlock unlimited AI generations.</p>
<label>Email</label><input type="email" id="email" placeholder="you@example.com"/>
<label>Password</label><input type="password" id="password"/>
<button onclick="login()">Sign In</button>
<div id="status"></div>
<script>
const vscode=acquireVsCodeApi();
function login(){vscode.postMessage({command:'login',email:document.getElementById('email').value,password:document.getElementById('password').value});}
window.addEventListener('message',event=>{if(event.data.type==='loginSuccess'){
  document.querySelectorAll('label,input,button').forEach(e=>e.style.display='none');
  const s=document.getElementById('status');s.style.display='block';
  s.innerHTML='<h3>\u2713 Active</h3><p>Plan: <strong>'+event.data.plan+'</strong></p>';}});
</script></body></html>`;
}
