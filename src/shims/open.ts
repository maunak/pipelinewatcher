import * as vscode from 'vscode';

/**
 * Shim for the `open` npm package.
 * `@azure/identity` uses `open` to launch the browser during interactive auth.
 * Replaced with VS Code's native API to avoid ESM bundling issues.
 */
async function open(target: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(target));
}

export = open;
