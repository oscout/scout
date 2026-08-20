// Generated from Hudson relay zellij.
// Refresh with: node ./scripts/sync-terminal-relay-session.mjs
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface ZellijLayoutInput {
  cwd: string;
  commandBin: string;
  commandArgs: string[];
}

export interface ZellijAttachArgsInput {
  sessionName: string;
  controlMode?: 'owner' | 'takeover' | 'observe';
  layoutPath?: string;
  cwd?: string;
}

function kdlString(value: string): string {
  return JSON.stringify(value);
}

export function createZellijLayoutFile({ cwd, commandBin, commandArgs }: ZellijLayoutInput): string {
  const dir = mkdtempSync(join(tmpdir(), 'hudson-zellij-'));
  const layoutPath = join(dir, 'layout.kdl');
  const argsBlock = commandArgs.length > 0
    ? `\n            args ${commandArgs.map(kdlString).join(' ')}`
    : '';
  const layout = `layout {\n    pane command=${kdlString(commandBin)} {\n        cwd ${kdlString(cwd)}${argsBlock}\n    }\n}\n`;
  writeFileSync(layoutPath, layout, 'utf8');
  return layoutPath;
}

export function prepareZellijSocketDir(socketDir?: string): Record<string, string> {
  if (!socketDir) return {};
  mkdirSync(socketDir, { recursive: true });
  return { ZELLIJ_SOCKET_DIR: socketDir };
}

export function buildZellijAttachArgs({
  sessionName,
  controlMode = 'owner',
  layoutPath,
  cwd,
}: ZellijAttachArgsInput): string[] {
  if (controlMode === 'observe') {
    return ['watch', sessionName];
  }

  const args = ['attach', '--create', sessionName];
  const optionArgs: string[] = [];
  if (layoutPath) optionArgs.push('--default-layout', layoutPath);
  if (cwd) optionArgs.push('--default-cwd', cwd);
  if (optionArgs.length > 0) args.push('options', ...optionArgs);
  return args;
}
