# Fabric Pipeline Watcher

A VS Code extension for monitoring Microsoft Fabric data pipeline runs.

---

## What it does

- Shows all your Fabric data pipelines in a live dashboard table
- Displays last run status, duration, success rate, and history per pipeline
- Sends VS Code notifications when a favorited pipeline fails or exceeds a duration threshold
- Lets you re-run pipelines, open them in the Fabric portal, and copy run IDs directly from the table
- Stores run history locally — no external backend
- Supports multiple Azure tenants

---

## Requirements

- VS Code 1.85+
- Azure CLI installed and signed in (`az login`)
- Access to a Microsoft Fabric workspace

---

## Running locally

```bash
npm install
npm run compile
```

Press **F5** to launch the Extension Development Host.
