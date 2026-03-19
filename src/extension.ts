import * as vscode from 'vscode';
import { DashboardPanel } from './panels/DashboardPanel';
import { FabricApiService } from './services/fabricApi';
import { AuthService } from './services/authService';
import { StorageService } from './services/storageService';
import { AlertService } from './services/alertService';
import { Tenant } from './models/types';

let _storage: StorageService;
let _alertService: AlertService;
let _pollingTimer: ReturnType<typeof setTimeout> | undefined;

// ─── Extension activation ─────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[PipelineWatch] Activating...');

  const authService = new AuthService();
  _storage = new StorageService(context);
  _alertService = new AlertService(_storage, context);

  try {
    await _storage.initialize();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`PipelineWatch: ${msg}`, 'OK');
    return;
  }

  const fabricApi = new FabricApiService(authService);

  const tenants = context.globalState.get<Tenant[]>('pipelineWatch.tenants', []);
  if (tenants.length > 0) {
    _alertService.scheduleDailyReport(tenants[0].tenantId);
  }

  context.subscriptions.push(

    // pipelineWatch.openDashboard ─────────────────────────────────────────────
    vscode.commands.registerCommand('pipelineWatch.openDashboard', () => {
      const panel = DashboardPanel.createOrShow(
        context.extensionUri, fabricApi, _storage, _alertService, context,
      );
      startPolling(panel);
    }),

    // pipelineWatch.addTenant ─────────────────────────────────────────────────
    vscode.commands.registerCommand('pipelineWatch.addTenant', async () => {
      const name = await vscode.window.showInputBox({
        title: 'PipelineWatch — Add Tenant',
        prompt: 'Enter a display name for this tenant',
        placeHolder: 'e.g. Production, Client A, Dev...',
        validateInput: v => v.trim().length > 0 ? null : 'Name cannot be empty',
      });
      if (!name) return;

      const tenantId = await vscode.window.showInputBox({
        title: 'PipelineWatch — Add Tenant',
        prompt: 'Enter the Azure Tenant ID (GUID)',
        placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
        validateInput: v =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())
            ? null
            : 'Invalid Tenant ID — must be a UUID',
      });
      if (!tenantId) return;

      const existing = context.globalState.get<Tenant[]>('pipelineWatch.tenants', []);

      if (existing.some(t => t.tenantId.toLowerCase() === tenantId.trim().toLowerCase())) {
        vscode.window.showWarningMessage(`Tenant "${name}" is already configured.`);
        return;
      }

      const newTenant: Tenant = { id: tenantId.trim(), name: name.trim(), tenantId: tenantId.trim() };
      existing.push(newTenant);
      await context.globalState.update('pipelineWatch.tenants', existing);

      if (existing.length === 1) {
        _alertService.scheduleDailyReport(newTenant.tenantId);
      }

      vscode.window.showInformationMessage(`✅ Tenant "${name}" added to PipelineWatch`);

      if (DashboardPanel.currentPanel) {
        DashboardPanel.currentPanel.reloadTenants();
        await DashboardPanel.currentPanel.refresh();
      }
    }),

    // pipelineWatch.exportHistory ─────────────────────────────────────────────
    vscode.commands.registerCommand('pipelineWatch.exportHistory', async () => {
      vscode.window.showInformationMessage(
        'Use the Export CSV / Export JSON buttons inside the History panel.',
      );
    }),

    // pipelineWatch.clearHistory ──────────────────────────────────────────────
    vscode.commands.registerCommand('pipelineWatch.clearHistory', async () => {
      const answer = await vscode.window.showWarningMessage(
        'This will permanently delete all locally stored pipeline run history. This cannot be undone.',
        { modal: true },
        'Delete All History',
      );
      if (answer !== 'Delete All History') return;

      _storage.clearAllHistory();
      vscode.window.showInformationMessage('PipelineWatch: Local history cleared.');

      if (DashboardPanel.currentPanel) {
        await DashboardPanel.currentPanel.refresh();
      }
    }),

    // Internal: open history for a specific pipeline ──────────────────────────
    vscode.commands.registerCommand('pipelineWatch.openHistory', async (pipelineId: string) => {
      if (!pipelineId) return;
      const lastRun = _storage.getLastRun(pipelineId);
      if (lastRun) {
        const { HistoryPanel: HP } = await import('./panels/HistoryPanel');
        HP.createOrShow(context.extensionUri, {
          id: pipelineId,
          displayName: lastRun.pipelineName,
          workspaceId: lastRun.workspaceId,
          workspaceName: lastRun.workspaceName,
          tenantId: lastRun.tenantId,
        }, _storage);
      } else if (DashboardPanel.currentPanel) {
        await DashboardPanel.currentPanel.refresh();
      }
    }),

  );

  context.subscriptions.push({
    dispose: () => {
      stopPolling();
      _alertService.dispose();
      _storage.close();
    },
  });

  console.log('[PipelineWatch] Activated.');
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

function startPolling(panel: DashboardPanel): void {
  stopPolling();

  const tick = async () => {
    if (!DashboardPanel.currentPanel) {
      stopPolling();
      return;
    }
    await DashboardPanel.currentPanel.refresh();
    const intervalSecs = vscode.workspace
      .getConfiguration('pipelineWatch')
      .get<number>('pollingInterval', 60);
    const nextAt = new Date(Date.now() + intervalSecs * 1000).toISOString();
    DashboardPanel.currentPanel?.setNextRefreshAt(nextAt);
    _pollingTimer = setTimeout(tick, intervalSecs * 1000);
  };

  const intervalSecs = vscode.workspace
    .getConfiguration('pipelineWatch')
    .get<number>('pollingInterval', 60);
  const nextAt = new Date(Date.now() + intervalSecs * 1000).toISOString();
  panel.setNextRefreshAt(nextAt);
  _pollingTimer = setTimeout(tick, intervalSecs * 1000);
}

function stopPolling(): void {
  if (_pollingTimer !== undefined) {
    clearTimeout(_pollingTimer);
    _pollingTimer = undefined;
  }
}

export function deactivate(): void {
  stopPolling();
}
