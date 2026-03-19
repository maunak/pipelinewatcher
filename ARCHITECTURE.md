# Architecture

## Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                              USER                                   │
│          opens dashboard · adds tenant · clicks actions             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  extension.ts                                                       │
│  Registers commands · wires services · starts polling timer         │
└───────┬───────────────────────┬───────────────────────┬─────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐     ┌─────────────────┐     ┌─────────────────────┐
│ DashboardPanel│     │  StorageService │     │   AlertService      │
│               │◄───►│                 │     │                     │
│  Webview      │     │  SQLite (local) │     │  Failure alerts     │
│  Controller   │     │  runs · favs ·  │     │  Duration checks    │
│               │     │  annotations    │     │  Daily report       │
└───────┬───┬───┘     └─────────────────┘     └─────────────────────┘
        │   │                                          ▲
        │   │   messages (postMessage)                 │
        │   │                                          │
        │   ▼                                          │
        │  ┌─────────────────────────────────┐         │
        │  │  dashboard.js  (Webview UI)     │         │
        │  │  Pipeline table · filters       │         │
        │  │  hover actions · workspace pick │         │
        │  └─────────────────────────────────┘         │
        │                                              │
        ▼                                              │
┌───────────────┐                                      │
│ HistoryPanel  │◄──── user clicks 📊 on a row         │
│               │                                      │
│  Webview      │──► reads runs from StorageService    │
│  Controller   │                                      │
└───────┬───────┘                                      │
        │                                              │
        ▼                                              │
┌─────────────────────────────────┐                    │
│  history.js  (Webview UI)       │                    │
│  Duration chart · run table     │                    │
│  CSV / JSON export to disk      │                    │
└─────────────────────────────────┘                    │
                                                       │
┌─────────────────────────────────────────────────────-┘
│
│   DashboardPanel also calls:
│
│   ┌─────────────────────────────────────────────────────────┐
│   │  FabricApiService                                       │
│   │  GET /workspaces · /dataPipelines · /jobs               │
│   │  Retry on 429 · pagination · 30s timeout                │
│   └───────────────────┬─────────────────────────────────────┘
│                       │ needs a token
│                       ▼
│   ┌─────────────────────────────────────────────────────────┐
│   │  AuthService                                            │
│   │  1. Try Azure CLI  (az login)                           │
│   │  2. Fall back to interactive browser                    │
│   │  Token cached per tenant · refreshed before expiry      │
│   └───────────────────┬─────────────────────────────────────┘
│                       │ bearer token
│                       ▼
│   ┌─────────────────────────────────────────────────────────┐
│   │  Microsoft Fabric REST API                              │
│   │  api.fabric.microsoft.com/v1                            │
│   └─────────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────
```

---

## Component Breakdown

| Component | File | Responsibility |
|---|---|---|
| Activation | `extension.ts` | Registers commands, wires services, starts polling timer |
| DashboardPanel | `panels/DashboardPanel.ts` | Owns the webview, handles all messages, orchestrates refreshes |
| HistoryPanel | `panels/HistoryPanel.ts` | Per-pipeline history view, chart data, CSV/JSON export |
| AuthService | `services/authService.ts` | Gets bearer tokens via Azure CLI or interactive browser, caches per tenant |
| FabricApiService | `services/fabricApi.ts` | Calls Fabric REST API, retries on 429, paginates results |
| StorageService | `services/storageService.ts` | SQLite DB in VS Code global storage — runs, annotations, favorites |
| AlertService | `services/alertService.ts` | Fires failure/threshold notifications, schedules daily summary |
| Webview (dashboard) | `webview/dashboard.js` | Renders pipeline table, handles user interactions, posts messages |
| Webview (history) | `webview/history.js` | Renders duration chart and run table, triggers export |

---

## Data Flow on Refresh

```
Polling timer fires (every N seconds)
  └─ DashboardPanel.refresh()
       ├─ AuthService.getToken(tenantId)        ← cached or from Azure AD
       ├─ FabricApi.listWorkspaces()            ← GET /workspaces
       ├─ FabricApi.listPipelines(workspaceId)  ← GET /workspaces/{id}/dataPipelines
       ├─ For each stale pipeline:
       │    └─ FabricApi.getLastRun()           ← GET /dataPipelines/{id}/jobs (batched)
       ├─ StorageService.saveRuns()             ← persisted to SQLite
       ├─ AlertService.check()                  ← notify on failure or slow run
       └─ DashboardPanel._post({ type: 'updateState', state })
            └─ Webview re-renders table
```
