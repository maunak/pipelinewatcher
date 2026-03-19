import fetch from 'node-fetch';
import { AuthService, FABRIC_SCOPE } from './authService';
import { Workspace, Pipeline, PipelineRun, RunStatus } from '../models/types';

const BASE_URL = 'https://api.fabric.microsoft.com/v1';
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRY_WAIT_MS = 60_000;

/** Ensure a UTC datetime string from the Fabric API has a trailing 'Z'. */
function asUtcIso(s: string): string {
  return s.endsWith('Z') ? s : s + 'Z';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Wraps a fetch call with automatic retry on 429 (rate limit). */
async function fetchWithRetry(
  fn: () => Promise<import('node-fetch').Response>,
  label: string,
): Promise<import('node-fetch').Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fn();

    if (response.status !== 429) {
      return response;
    }

    if (attempt === MAX_RETRIES) {
      return response;
    }

    const retryAfterHeader = response.headers.get('Retry-After');
    const retrySecs = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
    const waitMs = isNaN(retrySecs)
      ? Math.min(1000 * 2 ** attempt, 30_000)
      : Math.min(retrySecs * 1000, MAX_RETRY_WAIT_MS);

    console.warn(`[PipelineWatch] 429 rate limit on ${label} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(waitMs);
  }

  throw new Error(`[PipelineWatch] fetchWithRetry: exhausted all retries on ${label}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws if any of the given ID strings is not a valid UUID. */
function assertUuids(...ids: string[]): void {
  for (const id of ids) {
    if (!UUID_RE.test(id)) {
      throw new Error(`Invalid UUID: ${id}`);
    }
  }
}

/** Validates that a pagination URL returned by the API points to the expected origin. */
function isSafeNextUrl(nextUrl: string, expectedBase: string): boolean {
  try {
    const next = new URL(nextUrl);
    const base = new URL(expectedBase);
    return next.origin === base.origin;
  } catch {
    return false;
  }
}

// ─── Response interfaces ──────────────────────────────────────────────────────

interface FabricListResponse<T> {
  value: T[];
  continuationToken?: string;
  continuationUri?: string;
}

interface FabricWorkspace {
  id: string;
  displayName: string;
  type: string;
}

interface FabricPipeline {
  id: string;
  displayName: string;
  type: string;
}

interface FabricRun {
  id: string;
  itemId?: string;
  jobType?: string;
  invokeType?: string;
  status: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: { message?: string; errorCode?: string };
}

// ─────────────────────────────────────────────────────────────────────────────

export class FabricApiService {
  constructor(private readonly auth: AuthService) {}

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async request<T>(tenantId: string, path: string, options?: { method?: string; body?: string }): Promise<T> {
    const token = await this.auth.getToken(tenantId);
    const url = `${BASE_URL}${path}`;

    const response = await fetchWithRetry(
      () => fetch(url, {
        method: options?.method ?? 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: options?.body,
        timeout: FETCH_TIMEOUT_MS,
      }),
      path.split('?')[0],
    );

    if (!response.ok) {
      if (response.status === 401) {
        this.auth.clearCredential(tenantId);
      }
      throw new Error(`Fabric API error ${response.status} on ${path.split('?')[0]}`);
    }

    return response.json() as Promise<T>;
  }

  /** Follows continuationUri to fetch all pages. Capped at 50 pages / 5 000 items. */
  private async listAll<T>(tenantId: string, path: string): Promise<T[]> {
    const MAX_PAGES = 50;
    const MAX_ITEMS = 5_000;

    const results: T[] = [];
    let url: string | undefined = `${BASE_URL}${path}`;
    let pages = 0;

    while (url) {
      if (pages >= MAX_PAGES) {
        console.warn(`[PipelineWatch] listAll: hit ${MAX_PAGES}-page limit on ${path}, truncating results`);
        break;
      }
      if (results.length >= MAX_ITEMS) {
        console.warn(`[PipelineWatch] listAll: hit ${MAX_ITEMS}-item limit on ${path}, truncating results`);
        break;
      }

      const token = await this.auth.getToken(tenantId);
      const currentUrl = url;
      const response = await fetchWithRetry(
        () => fetch(currentUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: FETCH_TIMEOUT_MS,
        }),
        path.split('?')[0],
      );

      if (!response.ok) {
        if (response.status === 401) {
          this.auth.clearCredential(tenantId);
        }
        throw new Error(`Fabric API error ${response.status} on ${path.split('?')[0]}`);
      }

      const data = await response.json() as FabricListResponse<T>;
      results.push(...(data.value ?? []));
      const nextUri = data.continuationUri;
      url = nextUri && isSafeNextUrl(nextUri, BASE_URL) ? nextUri : undefined;
      pages++;
    }

    return results;
  }

  // ─── Run-mapping helper ───────────────────────────────────────────────────

  private _mapRuns(items: FabricRun[], pipelineId: string): PipelineRun[] {
    const runs = items.map(r => {
      const startIso = r.startTimeUtc ? asUtcIso(r.startTimeUtc) : undefined;
      const endIso   = r.endTimeUtc   ? asUtcIso(r.endTimeUtc)   : undefined;
      const start = startIso ? new Date(startIso).getTime() : undefined;
      const end   = endIso   ? new Date(endIso).getTime()   : undefined;
      const durationMs = start !== undefined && end !== undefined ? end - start : undefined;

      return {
        id: r.id,
        pipelineId,
        runId: r.id,
        status: this.normalizeStatus(r.status),
        startTime: startIso,
        endTime: endIso,
        durationMs,
        errorMessage: r.failureReason?.message,
      };
    });

    runs.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''));
    return runs;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async getWorkspaces(tenantId: string): Promise<Workspace[]> {
    const items = await this.listAll<FabricWorkspace>(tenantId, '/workspaces');
    return items
      .filter(w => w.type !== 'Personal')
      .map(w => ({
        id: w.id,
        displayName: w.displayName,
        tenantId,
      }));
  }

  async getPipelines(tenantId: string, workspaceId: string): Promise<Pipeline[]> {
    assertUuids(workspaceId);
    const items = await this.listAll<FabricPipeline>(tenantId, `/workspaces/${workspaceId}/dataPipelines`);
    return items.map(p => ({
      id: p.id,
      displayName: p.displayName,
      workspaceId,
      workspaceName: '',
      tenantId,
    }));
  }

  async getPipelineRuns(
    tenantId: string,
    workspaceId: string,
    pipelineId: string,
  ): Promise<PipelineRun[]> {
    assertUuids(workspaceId, pipelineId);
    const path = `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances`;
    const items = await this.listAll<FabricRun>(tenantId, path);
    return this._mapRuns(items, pipelineId);
  }

  /** Fetches only the first page of runs and returns the most recent one. */
  async getLastPipelineRun(
    tenantId: string,
    workspaceId: string,
    pipelineId: string,
  ): Promise<PipelineRun | undefined> {
    assertUuids(workspaceId, pipelineId);
    const path = `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances`;
    const data = await this.request<FabricListResponse<FabricRun>>(tenantId, path);
    const items = data.value ?? [];
    if (items.length === 0) return undefined;
    return this._mapRuns(items, pipelineId)[0];
  }

  /** Triggers a pipeline run. Returns the new job instance ID. */
  async triggerPipeline(tenantId: string, workspaceId: string, pipelineId: string): Promise<string> {
    assertUuids(workspaceId, pipelineId);
    const token = await this.auth.getToken(tenantId);
    const path = `/workspaces/${workspaceId}/dataPipelines/${pipelineId}/jobs/instances?jobType=Pipeline`;
    const url = `${BASE_URL}${path}`;

    const response = await fetchWithRetry(
      () => fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        timeout: FETCH_TIMEOUT_MS,
      }),
      path.split('?')[0],
    );

    if (!response.ok) {
      if (response.status === 401) this.auth.clearCredential(tenantId);
      throw new Error(`Fabric API error ${response.status} on ${path.split('?')[0]}`);
    }

    try {
      const body = await response.json() as { id?: string };
      return body.id ?? 'triggered';
    } catch {
      return 'triggered';
    }
  }

  // ─── Status normalization ─────────────────────────────────────────────────

  private normalizeStatus(raw: string): RunStatus {
    switch (raw?.toLowerCase()) {
      case 'succeeded':
      case 'completed':   return 'Succeeded';
      case 'failed':      return 'Failed';
      case 'inprogress':
      case 'in_progress':
      case 'running':     return 'InProgress';
      case 'cancelled':
      case 'canceled':    return 'Cancelled';
      case 'queued':
      case 'dequeued':    return 'Queued';
      default:            return 'NotStarted';
    }
  }
}

// Re-export scope constant for use in auth shim
export { FABRIC_SCOPE };
