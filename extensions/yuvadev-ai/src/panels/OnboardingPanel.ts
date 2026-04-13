import * as vscode from 'vscode';

import { BackendClient } from '../services/BackendClient';
import { KeychainService } from '../services/KeychainService';
import { humanizeError } from '../utils/ErrorHandler';

type CloudProvider = 'ollama-cloud' | 'openai' | 'anthropic' | 'deepseek';

type PanelMessage =
    | { command: 'selectMode'; mode: 'local' | 'cloud' }
    | { command: 'checkOllama' }
    | { command: 'verifyProvider'; provider: CloudProvider; apiKey: string }
    | { command: 'runTestTask'; task: string; mode: 'local' | 'cloud'; provider?: CloudProvider }
    | { command: 'completeSetup' };

export class OnboardingPanel {
    private static _current: OnboardingPanel | undefined;

    public static show(
        context: vscode.ExtensionContext,
        keychain: KeychainService,
        backendClient: BackendClient,
    ): OnboardingPanel {
        const col = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        if (OnboardingPanel._current) {
            OnboardingPanel._current._panel.reveal(col);
            return OnboardingPanel._current;
        }

        const panel = vscode.window.createWebviewPanel(
            'yuvadev.onboarding',
            'Welcome to YuvaDev',
            col,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );

        OnboardingPanel._current = new OnboardingPanel(panel, context, keychain, backendClient);
        return OnboardingPanel._current;
    }

    private _selectedMode: 'local' | 'cloud' | null = null;
    private _testSocket: any;

    private constructor(
        private readonly _panel: vscode.WebviewPanel,
        private readonly _context: vscode.ExtensionContext,
        private readonly _keychain: KeychainService,
        private readonly _backendClient: BackendClient,
    ) {
        this._panel.onDidDispose(() => this._dispose());
        this._panel.webview.onDidReceiveMessage((msg: PanelMessage) => void this._handleMessage(msg));
        this._panel.webview.html = this._buildHtml();
    }

    private _dispose(): void {
        if (this._testSocket) {
            try { this._testSocket.close(); } catch { /* ignore */ }
            this._testSocket = undefined;
        }
        if (OnboardingPanel._current === this) {
            OnboardingPanel._current = undefined;
        }
    }

    private async _handleMessage(msg: PanelMessage): Promise<void> {
        switch (msg.command) {
            case 'selectMode':
                this._selectedMode = msg.mode;
                return;
            case 'checkOllama':
                await this._checkOllama();
                return;
            case 'verifyProvider':
                await this._verifyProvider(msg.provider, msg.apiKey);
                return;
            case 'runTestTask':
                await this._runTestTask(msg.task, msg.mode, msg.provider);
                return;
            case 'completeSetup':
                await this._context.globalState.update('yuvadev.setupComplete', true);
                this._panel.dispose();
                await vscode.commands.executeCommand('workbench.view.extension.yuvadev');
                return;
            default:
                return;
        }
    }

    private async _checkOllama(): Promise<void> {
        try {
            const response = await fetch('http://localhost:11434/api/tags');
            if (!response.ok) {
                throw response;
            }
            const data = await response.json() as { models?: Array<{ name?: string }> };
            const hasModel = (data.models ?? []).some((m) => (m.name ?? '').startsWith('qwen3:4b'));

            if (hasModel) {
                this._post({
                    type: 'ollamaCheckResult',
                    ok: true,
                    message: '\u2713 Ollama is running. Model qwen3:4b found.',
                });
                return;
            }

            this._post({
                type: 'ollamaCheckResult',
                ok: false,
                message: '\u2717 Ollama not detected. Make sure it is running.',
            });
        } catch {
            this._post({
                type: 'ollamaCheckResult',
                ok: false,
                message: '\u2717 Ollama not detected. Make sure it is running.',
            });
        }
    }

    private async _verifyProvider(provider: CloudProvider, apiKey: string): Promise<void> {
        try {
            const response = await this._backendClient.post('/api/v1/settings/providers', {
                provider,
                api_key: apiKey,
            });
            if (!response.ok) {
                throw response;
            }
            const payload = await response.json() as { connected?: boolean; status?: string };
            const connected = Boolean(payload.connected);
            if (connected) {
                await this._keychain.storeKey(provider, apiKey);
            }
            this._post({
                type: 'providerCheckResult',
                ok: connected,
                message: connected ? '\u2713 API key verified.' : `\u2717 ${payload.status ?? 'Key verification failed.'}`,
            });
        } catch (error) {
            const readable = humanizeError(error);
            this._post({
                type: 'providerCheckResult',
                ok: false,
                message: `\u2717 ${readable.message}`,
            });
        }
    }

    private async _runTestTask(
        task: string,
        mode: 'local' | 'cloud',
        provider?: CloudProvider,
    ): Promise<void> {
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspace) {
            this._post({
                type: 'testError',
                title: 'No workspace open',
                message: 'Open a folder before running the test task.',
                action: 'Open a folder',
                command: 'workbench.action.files.openFolder',
            });
            return;
        }

        this._post({ type: 'testLog', line: '$ Starting YuvaDev test task...' });

        let sessionId = '';
        try {
            const response = await this._backendClient.post(
                '/api/v1/agent/loop/start',
                {
                    task,
                    workspace_root: workspace,
                    max_iterations: 12,
                    timeout_seconds: 180,
                },
                mode === 'cloud' ? provider : undefined,
            );
            if (!response.ok) {
                throw response;
            }
            const payload = await response.json() as { session_id: string };
            sessionId = payload.session_id;
            this._post({ type: 'testLog', line: `$ Connected to session ${sessionId}` });
        } catch (error) {
            const readable = humanizeError(error);
            this._post({
                type: 'testError',
                title: readable.title,
                message: readable.message,
                action: readable.action,
                command: readable.command,
            });
            return;
        }

        this._connectTestStream(sessionId);
    }

    private _connectTestStream(sessionId: string): void {
        if (this._testSocket) {
            try { this._testSocket.close(); } catch { /* ignore */ }
            this._testSocket = undefined;
        }

        let WS: any;
        try { WS = require('ws'); } catch {
            this._post({
                type: 'testError',
                title: 'WebSocket unavailable',
                message: 'Cannot stream test output in this environment.',
                action: 'Check output panel',
                command: 'workbench.action.output.toggleOutput',
            });
            return;
        }

        const ws = new WS(`ws://localhost:8125/api/v1/agent/loop/${sessionId}/stream`);
        this._testSocket = ws;
        let done = false;

        ws.on('open', () => {
            this._post({ type: 'testLog', line: '$ Streaming events...' });
        });

        ws.on('message', (raw: unknown) => {
            let event: any;
            try {
                const text = typeof raw === 'string' ? raw : String(raw);
                event = JSON.parse(text);
            } catch {
                return;
            }

            const line = this._formatStreamLine(event);
            if (line) {
                this._post({ type: 'testLog', line });
            }

            if (event.type === 'done') {
                done = true;
                this._post({ type: 'testSuccess' });
                try { ws.close(); } catch { /* ignore */ }
            }
            if (event.type === 'error') {
                done = true;
                this._post({
                    type: 'testError',
                    title: 'Test run failed',
                    message: event.data?.message ?? 'Unknown error from backend.',
                    action: 'Open Settings',
                    command: 'yuvadev.openSettings',
                });
                try { ws.close(); } catch { /* ignore */ }
            }
        });

        ws.on('error', (err: Error) => {
            if (done) { return; }
            this._post({
                type: 'testError',
                title: 'Stream error',
                message: err.message,
                action: 'Restart YuvaDev',
                command: 'yuvadev.restart',
            });
        });

        ws.on('close', () => {
            if (this._testSocket === ws) {
                this._testSocket = undefined;
            }
        });
    }

    private _formatStreamLine(event: any): string {
        const t = event?.type;
        const data = event?.data ?? {};
        if (t === 'iteration') {
            return `$ Iteration ${data.iteration}/${data.max}`;
        }
        if (t === 'thinking') {
            return `> ${String(data.text ?? 'Planning...').replace(/\s+/g, ' ').trim()}`;
        }
        if (t === 'tool_call') {
            return `$ ${data.tool ?? 'tool'} ${JSON.stringify(data.args ?? {})}`;
        }
        if (t === 'tool_result') {
            if (data.error) {
                return `! Tool error: ${data.error}`;
            }
            return `= ${String(data.output ?? '').slice(0, 120)}`;
        }
        if (t === 'approval_required') {
            return `? Approval required for ${data.event_type ?? 'action'}`;
        }
        if (t === 'approval_resolved') {
            return `= Approval ${data.decision ?? 'resolved'}`;
        }
        if (t === 'done') {
            return '= Task finished.';
        }
        if (t === 'error') {
            return `! ${data.message ?? 'Agent error'}`;
        }
        return '';
    }

    private _post(payload: unknown): void {
        this._panel.webview.postMessage(payload).then(undefined, () => {
            /* panel disposed */
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
  <title>YuvaDev Onboarding</title>
  <style>
    :root {
      color-scheme: dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 24px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      min-height: 100vh;
    }

    .wrap {
      max-width: 920px;
      margin: 0 auto;
    }

    h1 {
      margin: 0 0 16px;
      font-size: 24px;
      font-weight: 700;
    }

    .step-indicator {
      display: grid;
      grid-template-columns: 1fr auto 1fr auto 1fr;
      gap: 8px;
      align-items: center;
      margin-bottom: 24px;
    }

    .step-node {
      border: 1px solid var(--vscode-input-border);
      border-radius: 999px;
      padding: 8px 12px;
      text-align: center;
      font-size: 12px;
      opacity: 0.6;
      background: var(--vscode-editorWidget-background);
    }

    .step-node.active {
      opacity: 1;
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
    }

    .arrow {
      text-align: center;
      opacity: 0.5;
      font-size: 14px;
    }

    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
    }

    .option-card {
      border: 1px solid var(--vscode-input-border);
      border-radius: 10px;
      padding: 14px;
      background: var(--vscode-editorWidget-background);
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease;
      min-height: 110px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      justify-content: center;
    }

    .option-card:hover {
      transform: translateY(-1px);
      border-color: var(--vscode-focusBorder);
    }

    .option-card.active {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
    }

    .title {
      font-size: 16px;
      font-weight: 600;
    }

    .subtitle {
      opacity: 0.8;
      font-size: 13px;
      line-height: 1.4;
    }

    .panel {
      border: 1px solid var(--vscode-input-border);
      border-radius: 10px;
      padding: 16px;
      background: var(--vscode-editorWidget-background);
      margin-bottom: 16px;
    }

    .line {
      margin-bottom: 8px;
      font-size: 13px;
    }

    .provider-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
      margin-bottom: 10px;
    }

    .provider-card {
      border: 1px solid var(--vscode-input-border);
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      background: var(--vscode-input-background);
      text-align: center;
      font-size: 13px;
    }

    .provider-card.active {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset;
    }

    input[type='text'] {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 9px 10px;
      font-size: 13px;
      margin-bottom: 8px;
      outline: none;
    }

    input[type='text']:focus {
      border-color: var(--vscode-focusBorder);
    }

    .status {
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 13px;
      display: none;
      margin-top: 8px;
      border: 1px solid transparent;
    }

    .status.ok {
      display: block;
      color: #72e072;
      border-color: #2f7f2f;
      background: rgba(40, 95, 40, 0.25);
    }

    .status.err {
      display: block;
      color: #ff8c8c;
      border-color: #7f2f2f;
      background: rgba(105, 28, 28, 0.25);
    }

    .actions {
      margin-top: 18px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
    }

    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .terminal {
      height: 260px;
      overflow-y: auto;
      border-radius: 8px;
      border: 1px solid var(--vscode-input-border);
      background: #0f1115;
      color: #d7dde8;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.5;
      padding: 10px;
      white-space: pre-wrap;
    }

    .hidden {
      display: none;
    }

    @media (max-width: 720px) {
      body {
        padding: 14px;
      }

      .step-indicator {
        grid-template-columns: 1fr;
      }

      .arrow {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Set up YuvaDev in 3 quick steps</h1>

    <div class="step-indicator">
      <div id="node1" class="step-node active">1. Choose provider</div>
      <div class="arrow">&#8594;</div>
      <div id="node2" class="step-node">2. Configure</div>
      <div class="arrow">&#8594;</div>
      <div id="node3" class="step-node">3. Test run</div>
    </div>

    <section id="step1">
      <div class="card-grid">
        <div id="mode-local" class="option-card">
          <div class="title">Run locally with Ollama</div>
          <div class="subtitle">Free, private, no GPU required for small models</div>
        </div>
        <div id="mode-cloud" class="option-card">
          <div class="title">Use a cloud provider</div>
          <div class="subtitle">Faster results. Requires an API key.</div>
        </div>
      </div>
      <div class="actions">
        <button id="next1" disabled>Next &#8594;</button>
      </div>
    </section>

    <section id="step2" class="hidden">
      <div id="local-config" class="panel hidden">
        <div class="line">1. Install Ollama from <b>ollama.ai</b></div>
        <div class="line">2. Run: <code>ollama pull qwen3:4b</code></div>
        <button id="btn-check-ollama" class="secondary">Check Ollama is running</button>
        <div id="ollama-status" class="status"></div>
      </div>

      <div id="cloud-config" class="panel hidden">
        <div class="provider-grid">
          <div class="provider-card active" data-provider="ollama-cloud">Ollama Cloud</div>
          <div class="provider-card" data-provider="openai">OpenAI</div>
          <div class="provider-card" data-provider="anthropic">Anthropic</div>
          <div class="provider-card" data-provider="deepseek">DeepSeek</div>
        </div>
        <input id="provider-key" type="text" placeholder="Paste API key" />
        <button id="btn-verify-key" class="secondary">Verify key</button>
        <div id="provider-status" class="status"></div>
      </div>

      <div class="actions">
        <button id="back2" class="secondary">&#8592; Back</button>
        <button id="next2" disabled>Next &#8594;</button>
      </div>
    </section>

    <section id="step3" class="hidden">
      <div class="panel">
        <div class="line">Test task</div>
        <input id="test-task" type="text" value="Create a file called hello.py that prints Hello from YuvaDev" />
        <button id="btn-run-test" class="secondary">Run test task</button>
        <div id="test-ok" class="status"></div>
      </div>

      <div class="terminal" id="terminal-log"></div>

      <div class="actions">
        <button id="back3" class="secondary">&#8592; Back</button>
        <button id="start-building" disabled>Start building &#8594;</button>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const state = {
      step: 1,
      mode: null,
      provider: 'ollama-cloud',
      step2Ready: false,
      testPassed: false,
    };

    const modeLocal = document.getElementById('mode-local');
    const modeCloud = document.getElementById('mode-cloud');
    const next1 = document.getElementById('next1');

    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const step3 = document.getElementById('step3');

    const localConfig = document.getElementById('local-config');
    const cloudConfig = document.getElementById('cloud-config');

    const next2 = document.getElementById('next2');
    const back2 = document.getElementById('back2');
    const back3 = document.getElementById('back3');

    const ollamaStatus = document.getElementById('ollama-status');
    const providerStatus = document.getElementById('provider-status');
    const testOk = document.getElementById('test-ok');
    const terminalLog = document.getElementById('terminal-log');

    const startBuilding = document.getElementById('start-building');

    function setStep(step) {
      state.step = step;
      step1.classList.toggle('hidden', step !== 1);
      step2.classList.toggle('hidden', step !== 2);
      step3.classList.toggle('hidden', step !== 3);

      document.getElementById('node1').classList.toggle('active', step === 1);
      document.getElementById('node2').classList.toggle('active', step === 2);
      document.getElementById('node3').classList.toggle('active', step === 3);
    }

    function setStatus(el, ok, text) {
      el.textContent = text;
      el.className = 'status ' + (ok ? 'ok' : 'err');
    }

    function appendLog(line) {
      terminalLog.textContent += (terminalLog.textContent ? '\n' : '') + line;
      terminalLog.scrollTop = terminalLog.scrollHeight;
    }

    modeLocal.addEventListener('click', () => {
      state.mode = 'local';
      modeLocal.classList.add('active');
      modeCloud.classList.remove('active');
      next1.disabled = false;
      vscode.postMessage({ command: 'selectMode', mode: state.mode });
    });

    modeCloud.addEventListener('click', () => {
      state.mode = 'cloud';
      modeCloud.classList.add('active');
      modeLocal.classList.remove('active');
      next1.disabled = false;
      vscode.postMessage({ command: 'selectMode', mode: state.mode });
    });

    next1.addEventListener('click', () => {
      state.step2Ready = false;
      next2.disabled = true;
      setStep(2);

      const local = state.mode === 'local';
      localConfig.classList.toggle('hidden', !local);
      cloudConfig.classList.toggle('hidden', local);
      providerStatus.className = 'status';
      ollamaStatus.className = 'status';
    });

    back2.addEventListener('click', () => setStep(1));
    back3.addEventListener('click', () => setStep(2));

    document.getElementById('btn-check-ollama').addEventListener('click', () => {
      ollamaStatus.className = 'status';
      vscode.postMessage({ command: 'checkOllama' });
    });

    document.querySelectorAll('.provider-card').forEach((el) => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.provider-card').forEach((c) => c.classList.remove('active'));
        el.classList.add('active');
        state.provider = el.dataset.provider;
      });
    });

    document.getElementById('btn-verify-key').addEventListener('click', () => {
      const apiKey = document.getElementById('provider-key').value.trim();
      if (!apiKey) {
        setStatus(providerStatus, false, '\u2717 Enter an API key first.');
        return;
      }
      providerStatus.className = 'status';
      vscode.postMessage({
        command: 'verifyProvider',
        provider: state.provider,
        apiKey,
      });
    });

    next2.addEventListener('click', () => {
      setStep(3);
    });

    document.getElementById('btn-run-test').addEventListener('click', () => {
      testOk.className = 'status';
      terminalLog.textContent = '';
      state.testPassed = false;
      startBuilding.disabled = true;

      vscode.postMessage({
        command: 'runTestTask',
        task: document.getElementById('test-task').value,
        mode: state.mode,
        provider: state.provider,
      });
    });

    startBuilding.addEventListener('click', () => {
      vscode.postMessage({ command: 'completeSetup' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'ollamaCheckResult') {
        setStatus(ollamaStatus, msg.ok, msg.message);
        state.step2Ready = Boolean(msg.ok);
        next2.disabled = !state.step2Ready;
      }

      if (msg.type === 'providerCheckResult') {
        setStatus(providerStatus, msg.ok, msg.message);
        state.step2Ready = Boolean(msg.ok);
        next2.disabled = !state.step2Ready;
      }

      if (msg.type === 'testLog') {
        appendLog(msg.line);
      }

      if (msg.type === 'testSuccess') {
        setStatus(testOk, true, '\u2713 YuvaDev is working!');
        state.testPassed = true;
        startBuilding.disabled = false;
      }

      if (msg.type === 'testError') {
        const line = msg.title
          ? '! ' + msg.title + ': ' + msg.message
          : '! ' + msg.message;
        appendLog(line);
        setStatus(testOk, false, msg.message);
      }
    });
  </script>
</body>
</html>`;
    }
}

function _nonce(): string {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
