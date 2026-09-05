// Preset definitions for apps that honour Chromium's --user-data-dir. Each
// preset says where the stock app lives per platform and what, beyond the
// flag, has to be pinned to keep a profile fully separate.
//
// `env(profileDir)` returns extra environment for the launcher. ChatGPT keeps
// its Codex agent state outside the Chromium profile; Grok Bot resolves its
// data root with an empty argv, so the flag is invisible to that code path
// and SAND_DATA_ROOT is the override it does read.
import path from 'node:path';

export const APPS = [
  {
    id: 'claude', name: 'Claude', kind: 'electron', verified: true,
    darwin: { bundles: ['Claude.app'] },
    win32: {
      msix: { pattern: 'Claude_*__pzs8sxrjxfjjc', exe: 'app\\Claude.exe' },
      paths: ['%LOCALAPPDATA%\\AnthropicClaude\\app-*\\claude.exe', '%LOCALAPPDATA%\\Programs\\Claude\\Claude.exe'],
    },
    linux: { desktop: ['claude-desktop', 'claude', 'Claude'], bins: ['claude-desktop', 'claude'] },
  },
  {
    id: 'chatgpt', name: 'ChatGPT', kind: 'electron', verified: true,
    env: (p) => ({ CODEX_HOME: path.join(p, 'codex') }),
    darwin: { bundles: ['ChatGPT.app'] },
    win32: {
      msix: { pattern: 'OpenAI.ChatGPT-Desktop_*__2p2nqsd0c76g0', exe: 'app\\ChatGPT Classic.exe' },
      paths: ['%LOCALAPPDATA%\\Programs\\ChatGPT\\ChatGPT.exe'],
    },
    linux: { desktop: ['chatgpt', 'ChatGPT'], bins: ['chatgpt'] },
  },
  {
    id: 'grok-bot', name: 'Grok Bot', kind: 'electron', verified: true,
    env: (p) => ({ SAND_DATA_ROOT: path.join(p, 'sand-data') }),
    darwin: { bundles: ['Grok Bot.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\Grok Bot\\Grok Bot.exe'] },
    linux: { desktop: ['grok-bot', 'Grok Bot'], bins: ['grok-bot'] },
  },
  {
    id: 'slack', name: 'Slack', kind: 'electron',
    darwin: { bundles: ['Slack.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\slack\\app-*\\slack.exe', '%PROGRAMFILES%\\Slack\\slack.exe'] },
    linux: { desktop: ['slack', 'com.slack.Slack'], bins: ['slack'], flatpak: 'com.slack.Slack' },
  },
  {
    id: 'discord', name: 'Discord', kind: 'electron',
    darwin: { bundles: ['Discord.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Discord\\app-*\\Discord.exe'] },
    linux: { desktop: ['discord', 'com.discordapp.Discord'], bins: ['discord'], flatpak: 'com.discordapp.Discord' },
  },
  {
    id: 'notion', name: 'Notion', kind: 'electron',
    darwin: { bundles: ['Notion.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\Notion\\Notion.exe'] },
    linux: { desktop: ['notion-app', 'notion'], bins: ['notion-app'] },
  },
  {
    id: 'obsidian', name: 'Obsidian', kind: 'electron',
    darwin: { bundles: ['Obsidian.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.exe', '%LOCALAPPDATA%\\Obsidian\\Obsidian.exe'] },
    linux: { desktop: ['obsidian', 'md.obsidian.Obsidian'], bins: ['obsidian'], flatpak: 'md.obsidian.Obsidian' },
  },
  {
    id: 'vscode', name: 'Visual Studio Code', kind: 'electron',
    args: (p) => [`--extensions-dir=${path.join(p, 'extensions')}`],
    darwin: { bundles: ['Visual Studio Code.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%PROGRAMFILES%\\Microsoft VS Code\\Code.exe'] },
    linux: { desktop: ['code', 'com.visualstudio.code'], bins: ['code'], flatpak: 'com.visualstudio.code' },
  },
  {
    id: 'cursor', name: 'Cursor', kind: 'electron',
    args: (p) => [`--extensions-dir=${path.join(p, 'extensions')}`],
    darwin: { bundles: ['Cursor.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'] },
    linux: { desktop: ['cursor'], bins: ['cursor'] },
  },
  {
    id: 'chrome', name: 'Google Chrome', kind: 'chromium',
    darwin: { bundles: ['Google Chrome.app'] },
    win32: { paths: ['%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe', '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'] },
    linux: { desktop: ['google-chrome', 'com.google.Chrome'], bins: ['google-chrome', 'google-chrome-stable'], flatpak: 'com.google.Chrome' },
  },
  {
    id: 'edge', name: 'Microsoft Edge', kind: 'chromium',
    darwin: { bundles: ['Microsoft Edge.app'] },
    win32: { paths: ['%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe'] },
    linux: { desktop: ['microsoft-edge', 'com.microsoft.Edge'], bins: ['microsoft-edge'], flatpak: 'com.microsoft.Edge' },
  },
  {
    id: 'brave', name: 'Brave', kind: 'chromium',
    darwin: { bundles: ['Brave Browser.app'] },
    win32: { paths: ['%PROGRAMFILES%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'] },
    linux: { desktop: ['brave-browser', 'com.brave.Browser'], bins: ['brave-browser', 'brave'], flatpak: 'com.brave.Browser' },
  },
];

export function findApp(id) {
  const key = String(id).toLowerCase();
  return APPS.find((a) => a.id === key || a.name.toLowerCase() === key) || null;
}

/** A preset for an arbitrary app given by path. Isolation is assumed to be
 *  Chromium-style unless the caller overrides args. */
export function customApp(sourcePath, name) {
  const base = name || path.basename(sourcePath).replace(/\.(app|exe|desktop|AppImage)$/i, '');
  const id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  return { id, name: base, kind: 'custom', custom: true, source: sourcePath };
}
