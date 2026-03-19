# Publishing Guide

## 1. Build the .vsix locally

Install the VS Code packaging tool once:

```bash
npm install -g @vscode/vsce
```

Then build the package:

```bash
npm run package          # runs esbuild in production mode
vsce package --no-dependencies
```

This produces a file like `pipelinewatch-1.0.0.vsix` in the project root.

---

## 2. Install the .vsix manually (for testing)

In VS Code:

```
Cmd+Shift+P → Extensions: Install from VSIX...
```

Or via terminal:

```bash
code --install-extension pipelinewatch-1.0.0.vsix
```

---

## 3. Publish to the VS Code Marketplace

### One-time setup

1. Create a free account at https://marketplace.visualstudio.com
2. Go to https://dev.azure.com → create a Personal Access Token (PAT)
   - Scope: **Marketplace → Manage**
   - Copy the token — you only see it once
3. Login with vsce:

```bash
vsce login maunak
# paste your PAT when prompted
```

4. Make sure `package.json` has the right publisher:

```json
"publisher": "maunak"
```

### Publish

```bash
vsce publish
```

Or publish a specific version bump:

```bash
vsce publish patch   # 1.0.0 → 1.0.1
vsce publish minor   # 1.0.0 → 1.1.0
vsce publish major   # 1.0.0 → 2.0.0
```

---

## 4. GitHub Actions — automated build & release

The workflow at `.github/workflows/release.yml` does this automatically.

### What it does

| Trigger | What happens |
|---|---|
| Push any `v*.*.*` tag | Builds, packages, creates a GitHub Release with the .vsix attached, publishes to Marketplace |
| Manual (`workflow_dispatch`) | Builds and uploads the .vsix as a build artifact only |

### Setup steps

**Step 1 — Add your Marketplace PAT as a GitHub secret:**

1. Go to your repo → **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `VSCE_PAT`
4. Value: your Azure DevOps PAT (Marketplace → Manage scope)

**Step 2 — Push code to GitHub:**

```bash
git init
git remote add origin https://github.com/maunak/pipelinewatch.git
git add .
git commit -m "feat: initial release"
git push -u origin main
```

**Step 3 — Create and push a release tag:**

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers the workflow. GitHub Actions will:
1. Install dependencies
2. Run lint
3. Build the production bundle (`node esbuild.js --production`)
4. Package it into a `.vsix`
5. Create a GitHub Release with the `.vsix` attached
6. Publish to the VS Code Marketplace

### View workflow runs

Go to your repo → **Actions** tab to see live logs.

---

## 5. Versioning

Update the version in `package.json` before tagging:

```bash
npm version patch   # bumps patch and creates a git tag automatically
git push --follow-tags
```

Or manually edit `"version"` in `package.json`, commit, then tag.
