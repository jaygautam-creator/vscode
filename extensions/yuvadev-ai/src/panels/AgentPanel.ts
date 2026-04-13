import * as vscode from 'vscode';

import { BackendClient } from '../services/BackendClient';
import { humanizeError, type HumanizedError } from '../utils/ErrorHandler';

interface PendingDiffItem {
    path: string;
    original: string;
    proposed: string;
    lines_added: number;
    lines_removed: number;
}

interface PendingApprovalState {
    sessionId: string;
    approvalId: string;
    eventType: string;
    path?: string;
}

export class AgentPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'yuvadev.agentView';

    private _view?: vscode.WebviewView;
    private _socket: any;
    private _reconnectTimer: NodeJS.Timeout | undefined;
    private _reconnectAttempts = 0;

    private _sessionId = '';
    private _taskInput = '';
    private _pendingApproval: PendingApprovalState | null = null;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _backendClient: BackendClient,
    ) { }

    resolveWebviewView(
        view: vscode.WebviewView,
        _resolveContext: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this._buildHtml();

        view.webview.onDidReceiveMessage((msg: any) => {
            switch (msg.command) {
                case 'ready':
                    this._post({
                        type: 'bootState',
                        hasSession: Boolean(this._sessionId),
                        taskInput: this._taskInput,
                    });
                    break;
                case 'taskInputChanged':
                    this._taskInput = String(msg.value ?? '');
                    break;
                case 'start':
                    void this.startAgent(String(msg.task ?? '').trim());
                    break;
                case 'stop':
                    void this.stop();
                    break;
                case 'approve':
                    void this.approve();
                    break;
                case 'reject':
                    void this.reject();
                    break;
                case 'executeCommand': {
                    const command = String(msg.commandId ?? '');
                    if (command) {
                        void vscode.commands.executeCommand(command);
                    }
                    break;
                }
            }
        });

        view.onDidDispose(() => {
            this._view = undefined;
            this._closeSocket();
        });
    }

    public getTaskInput(): string {
        return this._taskInput;
    }

    public async startAgent(taskFromInput?: string): Promise<void> {
        const task = (taskFromInput ?? this._taskInput).trim();
        if (!task) {
            this._emitError({
                title: 'Task required',
                message: 'Enter a task to start the agent.',
                action: 'Enter task',
            });
            return;
        }

        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspace) {
            this._emitError({
                title: 'No workspace open',
                message: 'Open a project folder before starting the agent.',
                action: 'Open a folder',
                command: 'workbench.action.files.openFolder',
            });
            return;
        }

        this._taskInput = task;
        this._pendingApproval = null;
        this._sessionId = '';
        this._reconnectAttempts = 0;
        this._clearReconnectTimer();

        this._setContext('yuvadev.agentRunning', true);
        this._setContext('yuvadev.pendingApproval', false);
        this._setContext('yuvadev.hasPendingChanges', false);

        this._post({ type: 'agentStarted', task });

        try {
            const response = await this._backendClient.post('/api/v1/agent/loop/start', {
                task,
                workspace_root: workspace,
                max_iterations: 20,
                timeout_seconds: 300,
            });
            if (!response.ok) {
                throw response;
            }
            const payload = await response.json() as { session_id: string };
            this._sessionId = payload.session_id;
            this._post({ type: 'sessionReady', sessionId: this._sessionId });
            this._connectStream(this._sessionId);
        } catch (error) {
            this._setContext('yuvadev.agentRunning', false);
            this._emitError(humanizeError(error));
        }
    }

    public async stop(): Promise<void> {
        if (!this._sessionId) {
            return;
        }

        const sessionId = this._sessionId;
        try {
            await this._backendClient.post(`/api/v1/agent/loop/${sessionId}/stop`, {});
        } catch {
            // Stop is best-effort.
        }

        this._closeSocket();
        this._pendingApproval = null;
        this._sessionId = '';

        this._setContext('yuvadev.agentRunning', false);
        this._setContext('yuvadev.pendingApproval', false);
        this._setContext('yuvadev.hasPendingChanges', false);

        this._post({ type: 'agentStopped' });
    }

    public async approve(): Promise<void> {
        await this._resolveApproval(true);
    }

    public async reject(): Promise<void> {
        await this._resolveApproval(false);
    }

    private async _resolveApproval(approved: boolean): Promise<void> {
        if (!this._pendingApproval) {
            return;
        }

        const pending = this._pendingApproval;
        try {
            const response = await this._backendClient.post(
                `/api/v1/agent/loop/${pending.sessionId}/approve`,
                {
                    approval_id: pending.approvalId,
                    approved,
                    decision: approved ? 'approved' : 'rejected',
                },
            );
            if (!response.ok) {
                throw response;
            }

            this._pendingApproval = null;
            this._setContext('yuvadev.pendingApproval', false);
            this._setContext('yuvadev.hasPendingChanges', false);
            this._post({
                type: 'approvalResolved',
                approvalId: pending.approvalId,
                approved,
            });
        } catch (error) {
            this._emitError(humanizeError(error));
        }
    }

    private _connectStream(sessionId: string): void {
        this._closeSocket();

        let WS: any;
        try {
            WS = require('ws');
        } catch {
            this._emitError({
                title: 'WebSocket unavailable',
                message: 'Cannot connect to the agent stream in this environment.',
                action: 'Check output panel',
                command: 'workbench.action.output.toggleOutput',
            });
            return;
        }

        const ws = new WS(`ws://localhost:8125/api/v1/agent/loop/${sessionId}/stream`);
        this._socket = ws;

        ws.on('open', () => {
            this._reconnectAttempts = 0;
            this._post({ type: 'connectionState', state: 'connected' });
        });

        ws.on('message', (raw: unknown) => {
            let event: any;
            try {
                const text = typeof raw === 'string' ? raw : raw.toString();
                event = JSON.parse(text);
            } catch {
                return;
            }
            void this._handleAgentEvent(event);
        });

        ws.on('error', (_err: Error) => {
            this._post({
                type: 'connectionState',
                state: 'reconnecting',
            });
        });

        ws.on('close', () => {
            if (this._socket === ws) {
                this._socket = undefined;
            }
            if (!this._sessionId || this._sessionId !== sessionId) {
                return;
            }
            this._scheduleReconnect(sessionId);
        });
    }

    private async _handleAgentEvent(event: any): Promise<void> {
        this._post({ type: 'agentEvent', event });

        if (event.type === 'approval_required') {
            const approvalId = String(event.data?.approval_id ?? '');
            if (!approvalId) {
                return;
            }

            this._pendingApproval = {
                sessionId: this._sessionId,
                approvalId,
                eventType: String(event.data?.event_type ?? event.data?.tool ?? 'action'),
                path: event.data?.path,
            };

            this._setContext('yuvadev.pendingApproval', true);
            this._setContext('yuvadev.hasPendingChanges', true);

            const diff = await this._fetchPendingDiff(this._sessionId, event.data?.path);
            this._post({
                type: 'approvalRequired',
                approvalId,
                eventType: this._pendingApproval.eventType,
                path: event.data?.path ?? '',
                diff,
            });
            return;
        }

        if (event.type === 'done' || event.type === 'error' || event.type === 'stopped') {
            this._setContext('yuvadev.agentRunning', false);

            if (event.type === 'error') {
                this._emitError(humanizeError(event.data?.message ?? 'Agent failed'));
            }

            this._pendingApproval = null;
            this._setContext('yuvadev.pendingApproval', false);
            this._setContext('yuvadev.hasPendingChanges', false);
            this._sessionId = '';
            this._closeSocket();
        }
    }

    private async _fetchPendingDiff(sessionId: string, pathHint?: string): Promise<PendingDiffItem | null> {
        try {
            const response = await this._backendClient.get(`/api/v1/agent/loop/${sessionId}/pending-diff`);
            if (!response.ok) {
                return null;
            }
            const payload = await response.json() as PendingDiffItem[];
            if (!payload.length) {
                return null;
            }
            if (!pathHint) {
                return payload[0];
            }
            return payload.find((item) => item.path === pathHint || item.path.endsWith(pathHint)) ?? payload[0];
        } catch {
            return null;
        }
    }

    private _scheduleReconnect(sessionId: string): void {
        if (this._reconnectAttempts >= 5) {
            this._emitError({
                title: 'Connection lost',
                message: 'Could not reconnect to the agent stream.',
                action: 'Restart YuvaDev',
                command: 'yuvadev.restart',
            });
            this._setContext('yuvadev.agentRunning', false);
            this._setContext('yuvadev.pendingApproval', false);
            this._setContext('yuvadev.hasPendingChanges', false);
            this._sessionId = '';
            return;
        }

        this._reconnectAttempts += 1;
        this._post({
            type: 'connectionState',
            state: 'reconnecting',
            attempt: this._reconnectAttempts,
            max: 5,
        });

        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            if (this._sessionId === sessionId) {
                this._connectStream(sessionId);
            }
        }, 3000);
    }

    private _emitError(error: HumanizedError): void {
        this._post({
            type: 'agentError',
            error,
        });
    }

    private _closeSocket(): void {
        if (this._socket) {
            try {
                this._socket.close();
            } catch {
                // Ignore close races.
            }
            this._socket = undefined;
        }
        this._clearReconnectTimer();
    }

    private _clearReconnectTimer(): void {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = undefined;
        }
    }

    private _setContext(key: string, value: boolean): void {
        void vscode.commands.executeCommand('setContext', key, value);
    }

    private _post(payload: unknown): void {
        this._view?.webview.postMessage(payload).then(undefined, () => {
            // View may be hidden or disposed.
        });
    }

    private _buildHtml(): string {
        const nonce = _nonce();
        const csp = [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            "style-src 'unsafe-inline'",
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>YuvaDev Agent</title>
  <style>
    :root {
      color-scheme: dark;
      --accent: var(--vscode-focusBorder);
      --panel: var(--vscode-editorWidget-background);
      --border: var(--vscode-input-border);
      --danger: #f85149;
      --ok: #4ec77c;
      --warn: #e2b35f;
      --muted: var(--vscode-descriptionForeground);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      display: grid;
      grid-template-rows: auto auto 1fr auto;
    }

    .top {
      padding: 10px 10px 8px;
      border-bottom: 1px solid var(--border);
      display: none;
      gap: 8px;
      background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent);
    }

    .top.running {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
    }

    .progress-wrap {
      display: grid;
      gap: 5px;
    }

    .progress {
      height: 6px;
      border-radius: 999px;
      background: rgba(127,127,127,0.25);
      overflow: hidden;
    }

    .progress > span {
      display: block;
      height: 100%;
      width: 0;
      background: linear-gradient(90deg, #3aa0ff, #7be495);
      transition: width 140ms ease;
    }

    .token {
      font-size: 11px;
      color: var(--muted);
      text-align: right;
      white-space: nowrap;
    }

    .connection {
      padding: 6px 10px;
      font-size: 11px;
      color: var(--warn);
      border-bottom: 1px solid var(--border);
      display: none;
      background: rgba(130, 98, 28, 0.22);
    }

    .connection.show {
      display: block;
    }

    #feed {
      overflow-y: auto;
      padding: 10px;
      display: grid;
      gap: 8px;
      align-content: start;
    }

    .idle {
      border: 1px dashed var(--border);
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      background: radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 60%);
    }

    .idle svg {
      width: 62px;
      height: 62px;
      margin: 0 auto 10px;
      opacity: 0.85;
      display: block;
    }

    .idle h3 {
      margin: 0 0 8px;
      font-size: 16px;
    }

    .hint {
      color: var(--muted);
      font-size: 12px;
    }

    .event {
      border: 1px solid var(--border);
      border-left: 3px solid transparent;
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--panel);
      display: grid;
      gap: 4px;
      transition: opacity 120ms ease;
    }

    .event.current {
      border-left-color: var(--accent);
    }

    .event.completed {
      opacity: 0.68;
    }

    .event-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
    }

    .event-meta {
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }

    .pulse {
      animation: pulse 1.1s ease infinite;
    }

    @keyframes pulse {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }

    .summary {
      font-size: 12px;
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .approval {
      border: 1px solid rgba(226, 179, 95, 0.45);
      background: rgba(84, 61, 20, 0.22);
      border-radius: 8px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }

    .approval-title {
      font-size: 13px;
      font-weight: 700;
    }

    .approval-path {
      font-size: 12px;
      color: var(--muted);
      word-break: break-word;
    }

    .approval-actions,
    .approval-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .mini-bar {
      height: 6px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      overflow: hidden;
      flex: 1;
      min-width: 120px;
    }

    .mini-bar > span {
      display: block;
      height: 100%;
      width: 100%;
      background: linear-gradient(90deg, #e2b35f, #f3d28f);
    }

    .btn-link {
      border: none;
      background: transparent;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      padding: 0;
      font-size: 12px;
      text-decoration: underline;
    }

    .btn-row {
      display: flex;
      gap: 8px;
    }

    .btn {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-size: 12px;
      padding: 6px 10px;
      cursor: pointer;
    }

    .btn.approve {
      background: rgba(62, 133, 87, 0.28);
      border-color: rgba(78, 199, 124, 0.45);
      color: #9ff0be;
    }

    .btn.reject {
      background: rgba(133, 43, 43, 0.3);
      border-color: rgba(248,81,73,0.45);
      color: #ffaca6;
    }

    .diff {
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      background: rgba(0,0,0,0.22);
      overflow: hidden;
    }

    .diff-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      max-height: 220px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
    }

    .diff-col {
      border-right: 1px solid rgba(255,255,255,0.08);
    }

    .diff-col:last-child {
      border-right: none;
    }

    .diff-line {
      white-space: pre;
      padding: 2px 6px;
    }

    .diff-line.changed-left {
      background: rgba(226, 179, 95, 0.22);
    }

    .diff-line.changed-right {
      background: rgba(78, 199, 124, 0.22);
    }

    .error-card {
      border: 1px solid rgba(248,81,73,0.45);
      border-left: 4px solid var(--danger);
      border-radius: 8px;
      padding: 8px 10px;
      background: rgba(96, 32, 32, 0.28);
      display: grid;
      gap: 6px;
    }

    .error-title {
      font-size: 13px;
      font-weight: 700;
      color: #ffb4b0;
    }

    .error-message {
      font-size: 12px;
    }

    .bottom {
      border-top: 1px solid var(--border);
      padding: 10px;
      display: grid;
      gap: 8px;
      background: rgba(0,0,0,0.1);
    }

    #task {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 8px 10px;
      font-size: 13px;
      outline: none;
    }

    #task:focus {
      border-color: var(--accent);
    }

    .bottom-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .btn-primary {
      border: none;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 13px;
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-stop {
      border: none;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 13px;
      cursor: pointer;
      background: rgba(138, 36, 36, 0.75);
      color: #ffd4d1;
      display: none;
    }

    .btn-stop.show {
      display: inline-block;
    }

    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>
  <div id="top" class="top">
    <div class="progress-wrap">
      <div class="progress"><span id="progress-bar"></span></div>
      <div id="progress-label" class="hint"></div>
    </div>
    <div id="token" class="token">Tokens: 0 / 12,000</div>
  </div>

  <div id="connection" class="connection"></div>

  <div id="feed"></div>

  <div class="bottom">
    <input id="task" type="text" placeholder="Describe what to build..." />
    <div class="bottom-actions">
      <button id="start" class="btn-primary">Start</button>
      <button id="stop" class="btn-stop">Stop agent</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const state = {
      running: false,
      iteration: 0,
      maxIterations: 20,
      tokens: 0,
      feed: [],
      activeRows: new Map(),
      pendingApproval: null,
      connection: '',
      approvalTick: null,
    };

    const feedEl = document.getElementById('feed');
    const topEl = document.getElementById('top');
    const progressBar = document.getElementById('progress-bar');
    const progressLabel = document.getElementById('progress-label');
    const tokenEl = document.getElementById('token');
    const connectionEl = document.getElementById('connection');

    const taskInput = document.getElementById('task');
    const startBtn = document.getElementById('start');
    const stopBtn = document.getElementById('stop');

    taskInput.addEventListener('input', () => {
      vscode.postMessage({ command: 'taskInputChanged', value: taskInput.value });
    });

    startBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'start', task: taskInput.value });
    });

    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'stop' });
    });

    function formatRelative(ts) {
      const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (diff < 1) return 'now';
      if (diff < 60) return diff + 's ago';
      return Math.floor(diff / 60) + 'm ago';
    }

    function formatDuration(start, end) {
      const ms = Math.max(0, end - start);
      if (ms < 1000) return ms + 'ms';
      return (ms / 1000).toFixed(1) + 's';
    }

    function pushIdleState() {
      if (state.running) return;
      feedEl.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'idle';
      card.innerHTML =
        '<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<rect x="16" y="18" width="32" height="28" rx="7" stroke="currentColor" stroke-width="2"/>' +
          '<circle cx="26" cy="31" r="3" fill="currentColor"/>' +
          '<circle cx="38" cy="31" r="3" fill="currentColor"/>' +
          '<rect x="24" y="39" width="16" height="3" rx="1.5" fill="currentColor"/>' +
          '<path d="M32 18V11" stroke="currentColor" stroke-width="2"/>' +
          '<circle cx="32" cy="9" r="3" fill="currentColor"/>' +
        '</svg>' +
        '<h3>Ask YuvaDev to build something</h3>' +
        '<div class="hint">⌘+Shift+A to trigger agent</div>';
      feedEl.appendChild(card);
    }

    function renderProgress() {
      topEl.classList.toggle('running', state.running);
      const pct = state.maxIterations > 0
        ? Math.min(100, Math.round((state.iteration / state.maxIterations) * 100))
        : 0;
      progressBar.style.width = pct + '%';
      progressLabel.textContent = state.running
        ? 'Iteration ' + state.iteration + ' / ' + state.maxIterations
        : '';
      tokenEl.textContent = 'Tokens: ' + state.tokens.toLocaleString() + ' / 12,000';
    }

    function renderConnection() {
      if (!state.connection) {
        connectionEl.classList.remove('show');
        connectionEl.textContent = '';
        return;
      }
      connectionEl.classList.add('show');
      connectionEl.textContent = state.connection;
    }

    function mapToolLabel(tool, args) {
      const path = args?.path || args?.file_path || args?.target || '';
      if (tool === 'read_file') return '📄 Reading ' + (path || 'file');
      if (tool === 'write_file') return '✏️  Writing ' + (path || 'file');
      if (tool === 'run_command') return '⚡ Running: ' + (args?.command || 'command');
      if (tool === 'search_files' || tool === 'search_codebase') return '🔍 Searching: ' + (args?.query || 'workspace');
      return '🛠️  ' + tool;
    }

    function appendEventRow(row) {
      state.feed.push(row);
      renderFeed();
      feedEl.scrollTop = feedEl.scrollHeight;
    }

    function renderApproval(row) {
      if (row.resolved) {
        const collapsed = document.createElement('div');
        collapsed.className = 'summary';
        collapsed.textContent = 'Approval resolved. Feed continued.';
        return collapsed;
      }

      const remaining = Math.max(0, row.expiresAt - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      const pct = Math.max(0, Math.min(100, Math.round((remaining / 120000) * 100)));

      const wrap = document.createElement('div');
      wrap.className = 'approval';

      const header = document.createElement('div');
      header.className = 'approval-title';
      header.textContent = '⚠ Agent wants to: ' + row.eventType.replace(/_/g, ' ');
      wrap.appendChild(header);

      const path = document.createElement('div');
      path.className = 'approval-path';
      path.textContent = 'Path: ' + (row.path || 'Unknown path');
      wrap.appendChild(path);

      const toggle = document.createElement('button');
      toggle.className = 'btn-link';
      toggle.textContent = row.expanded ? 'Show diff ▲' : 'Show diff ▼';
      toggle.addEventListener('click', () => {
        row.expanded = !row.expanded;
        renderFeed();
      });
      wrap.appendChild(toggle);

      if (row.expanded) {
        const diff = document.createElement('div');
        diff.className = 'diff';
        const grid = document.createElement('div');
        grid.className = 'diff-grid';

        const originalLines = (row.diff?.original || '').split('\n');
        const proposedLines = (row.diff?.proposed || '').split('\n');
        const max = Math.max(originalLines.length, proposedLines.length);

        const left = document.createElement('div');
        left.className = 'diff-col';
        const right = document.createElement('div');
        right.className = 'diff-col';

        for (let i = 0; i < max; i++) {
          const oldLine = originalLines[i] ?? '';
          const newLine = proposedLines[i] ?? '';
          const changed = oldLine !== newLine;

          const leftLine = document.createElement('div');
          leftLine.className = 'diff-line' + (changed ? ' changed-left' : '');
          leftLine.textContent = oldLine;
          left.appendChild(leftLine);

          const rightLine = document.createElement('div');
          rightLine.className = 'diff-line' + (changed ? ' changed-right' : '');
          rightLine.textContent = newLine;
          right.appendChild(rightLine);
        }

        grid.appendChild(left);
        grid.appendChild(right);
        diff.appendChild(grid);
        wrap.appendChild(diff);
      }

      const footer = document.createElement('div');
      footer.className = 'approval-footer';
      footer.innerHTML = '<span>Auto-rejecting in: ' + seconds + 's</span>' +
        '<div class="mini-bar"><span style="width:' + pct + '%"></span></div>';
      wrap.appendChild(footer);

      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      actions.innerHTML =
        '<div class="btn-row">' +
          '<button class="btn approve">✓ Approve</button>' +
          '<button class="btn reject">✗ Reject</button>' +
        '</div>';

      actions.querySelector('.approve').addEventListener('click', () => {
        vscode.postMessage({ command: 'approve' });
      });
      actions.querySelector('.reject').addEventListener('click', () => {
        vscode.postMessage({ command: 'reject' });
      });

      wrap.appendChild(actions);
      return wrap;
    }

    function renderErrorCard(row) {
      const card = document.createElement('div');
      card.className = 'error-card';

      const title = document.createElement('div');
      title.className = 'error-title';
      title.textContent = row.error.title;
      card.appendChild(title);

      const msg = document.createElement('div');
      msg.className = 'error-message';
      msg.textContent = row.error.message;
      card.appendChild(msg);

      if (row.error.action) {
        const btn = document.createElement('button');
        btn.className = 'btn-link';
        btn.textContent = row.error.action;
        btn.addEventListener('click', () => {
          if (row.error.command) {
            vscode.postMessage({ command: 'executeCommand', commandId: row.error.command });
          }
        });
        card.appendChild(btn);
      }

      return card;
    }

    function renderFeed() {
      if (!state.running && state.feed.length === 0) {
        pushIdleState();
        return;
      }

      feedEl.innerHTML = '';
      for (const row of state.feed) {
        const rowEl = document.createElement('div');
        rowEl.className = 'event';

        if (row.status === 'current') rowEl.classList.add('current');
        if (row.status === 'completed') rowEl.classList.add('completed');

        if (row.kind === 'approval') {
          rowEl.appendChild(renderApproval(row));
          feedEl.appendChild(rowEl);
          continue;
        }

        if (row.kind === 'error') {
          rowEl.appendChild(renderErrorCard(row));
          feedEl.appendChild(rowEl);
          continue;
        }

        const head = document.createElement('div');
        head.className = 'event-head';

        const label = document.createElement('div');
        label.textContent = row.text;
        if (row.kind === 'thinking') {
          label.classList.add('pulse');
        }
        head.appendChild(label);

        const meta = document.createElement('div');
        meta.className = 'event-meta';
        const rel = formatRelative(row.ts);
        if (row.completedAt) {
          meta.textContent = rel + ' · ' + formatDuration(row.ts, row.completedAt);
        } else {
          meta.textContent = rel;
        }
        head.appendChild(meta);

        rowEl.appendChild(head);

        if (row.summary) {
          const summary = document.createElement('div');
          summary.className = 'summary';
          summary.textContent = row.summary;
          rowEl.appendChild(summary);
        }

        feedEl.appendChild(rowEl);
      }
    }

    function clearFeedForRun() {
      state.feed = [];
      state.activeRows = new Map();
      state.iteration = 0;
      state.maxIterations = 20;
      state.tokens = 0;
      if (state.approvalTick) {
        clearInterval(state.approvalTick);
        state.approvalTick = null;
      }
      renderProgress();
      renderFeed();
    }

    function addAgentEvent(evt) {
      const ts = Date.now();
      state.tokens += Math.max(1, Math.round(JSON.stringify(evt).length / 4));

      if (evt.type === 'iteration') {
        state.iteration = evt.data?.iteration || state.iteration;
        state.maxIterations = evt.data?.max || state.maxIterations;
        renderProgress();
        return;
      }

      if (evt.type === 'tool_call') {
        const row = {
          id: evt.data?.id || 'tool-' + ts,
          kind: 'tool',
          text: mapToolLabel(evt.data?.tool || 'tool', evt.data?.args || {}),
          ts,
          status: 'current',
        };
        state.activeRows.set(row.id, row);
        appendEventRow(row);
        renderProgress();
        return;
      }

      if (evt.type === 'tool_result') {
        const id = evt.data?.id;
        const row = id ? state.activeRows.get(id) : null;
        if (row) {
          row.status = 'completed';
          row.completedAt = ts;
          if (evt.data?.error) {
            row.summary = evt.data.error;
          }
          renderFeed();
          return;
        }
      }

      if (evt.type === 'thinking') {
        appendEventRow({
          kind: 'thinking',
          text: '💭 Planning...',
          summary: evt.data?.text ? String(evt.data.text).slice(0, 180) : '',
          ts,
          status: 'current',
        });
        return;
      }

      if (evt.type === 'plan_approval_required') {
        const steps = Array.isArray(evt.data?.steps) ? evt.data.steps.length : 0;
        appendEventRow({
          kind: 'plan',
          text: '📋 Plan ready — ' + steps + ' steps',
          ts,
          status: 'completed',
          completedAt: ts,
        });
        return;
      }

      if (evt.type === 'plan_ready') {
        const steps = Array.isArray(evt.data?.steps)
          ? evt.data.steps.length
          : Array.isArray(evt.data?.plan)
            ? evt.data.plan.length
            : 0;
        appendEventRow({
          kind: 'plan',
          text: '📋 Plan ready — ' + steps + ' steps',
          ts,
          status: 'completed',
          completedAt: ts,
        });
        return;
      }

      if (evt.type === 'done') {
        appendEventRow({
          kind: 'done',
          text: '✅ Done',
          summary: evt.data?.summary || '',
          ts,
          status: 'completed',
          completedAt: ts,
        });
        state.running = false;
        stopBtn.classList.remove('show');
        renderProgress();
        renderFeed();
        return;
      }

      if (evt.type === 'error') {
        appendEventRow({
          kind: 'event',
          text: '⚠ Agent reported an error',
          summary: evt.data?.message || '',
          ts,
          status: 'completed',
          completedAt: ts,
        });
      }
    }

    function startApprovalCountdown() {
      if (state.approvalTick) {
        clearInterval(state.approvalTick);
      }
      state.approvalTick = setInterval(() => {
        const pending = state.feed.find((row) => row.kind === 'approval' && !row.resolved);
        if (!pending) {
          clearInterval(state.approvalTick);
          state.approvalTick = null;
          return;
        }
        if (Date.now() >= pending.expiresAt) {
          pending.resolved = true;
          vscode.postMessage({ command: 'reject' });
        }
        renderFeed();
      }, 1000);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'bootState') {
        if (msg.taskInput) {
          taskInput.value = msg.taskInput;
        }
        renderFeed();
      }

      if (msg.type === 'agentStarted') {
        state.running = true;
        state.connection = '';
        clearFeedForRun();
        stopBtn.classList.add('show');
        appendEventRow({
          kind: 'event',
          text: '🚀 Agent started',
          summary: msg.task,
          ts: Date.now(),
          status: 'completed',
          completedAt: Date.now(),
        });
        renderProgress();
        renderConnection();
        return;
      }

      if (msg.type === 'sessionReady') {
        appendEventRow({
          kind: 'event',
          text: '🔗 Session ' + msg.sessionId,
          ts: Date.now(),
          status: 'completed',
          completedAt: Date.now(),
        });
        return;
      }

      if (msg.type === 'agentEvent') {
        addAgentEvent(msg.event);
        return;
      }

      if (msg.type === 'approvalRequired') {
        const row = {
          kind: 'approval',
          approvalId: msg.approvalId,
          eventType: msg.eventType || 'action',
          path: msg.path,
          diff: msg.diff,
          expanded: false,
          ts: Date.now(),
          status: 'current',
          expiresAt: Date.now() + 120000,
          resolved: false,
        };
        appendEventRow(row);
        startApprovalCountdown();
        return;
      }

      if (msg.type === 'approvalResolved') {
        const pending = state.feed.find((row) => row.kind === 'approval' && row.approvalId === msg.approvalId);
        if (pending) {
          pending.resolved = true;
          pending.status = 'completed';
          pending.completedAt = Date.now();
        }
        appendEventRow({
          kind: 'event',
          text: msg.approved ? '✅ Approval granted' : '✗ Approval rejected',
          ts: Date.now(),
          status: 'completed',
          completedAt: Date.now(),
        });
        renderFeed();
        return;
      }

      if (msg.type === 'agentStopped') {
        state.running = false;
        stopBtn.classList.remove('show');
        state.connection = '';
        renderConnection();
        appendEventRow({
          kind: 'event',
          text: '⏹ Agent stopped',
          ts: Date.now(),
          status: 'completed',
          completedAt: Date.now(),
        });
        renderProgress();
        renderFeed();
        return;
      }

      if (msg.type === 'connectionState') {
        if (msg.state === 'connected') {
          state.connection = '';
        } else if (msg.state === 'reconnecting') {
          state.connection = '⚠ Connection lost — reconnecting...';
        }
        renderConnection();
        return;
      }

      if (msg.type === 'agentError') {
        appendEventRow({
          kind: 'error',
          error: msg.error,
          ts: Date.now(),
          status: 'completed',
          completedAt: Date.now(),
        });
        renderFeed();
        return;
      }
    });

    setInterval(() => {
      if (state.feed.length > 0) {
        renderFeed();
      }
    }, 1000);

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
    }
}

function _nonce(): string {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
