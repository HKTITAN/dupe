// Preset definitions for apps that honour Chromium's --user-data-dir. Each
// preset says where the stock app lives per platform, what — beyond the flag
// — has to be pinned to keep a profile fully separate, and where the app
// itself comes from if it isn't installed yet.
//
// `install` is read by install.js. Every id in it was checked against the
// registry that owns it rather than remembered: winget ids with `winget show`,
// casks against formulae.brew.sh, Flathub ids against flathub.org. Where a
// vendor has no manifest anyone owns, there is no id here — an app installed
// from a lookalike package is a worse outcome than one the user installs by
// hand, so those fall through to `page`. `url` is only for vendors that
// publish a stable "latest" endpoint of their own.
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
    install: {
      page: 'https://claude.com/download',
      hosts: ['claude.ai'],
      win32: { winget: 'Anthropic.Claude', url: 'https://claude.ai/api/desktop/win32/{arch}/setup/latest/redirect' },
      darwin: { url: 'https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect' },
      linux: {}, // no official Linux build; the page explains the options
    },
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
    install: {
      page: 'https://openai.com/chatgpt/download/',
      // The winget-source "ChatGPT" packages are third-party wrappers; the
      // app OpenAI ships on Windows is the Store one.
      win32: { winget: '9PLM9XGG6VKS', source: 'msstore' },
      darwin: { brew: 'chatgpt' },
      linux: {},
    },
  },
  {
    id: 'grok-bot', name: 'Grok Bot', kind: 'electron', verified: true,
    env: (p) => ({ SAND_DATA_ROOT: path.join(p, 'sand-data') }),
    darwin: { bundles: ['Grok Bot.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\Grok Bot\\Grok Bot.exe'] },
    linux: { desktop: ['grok-bot', 'Grok Bot'], bins: ['grok-bot'] },
    install: {
      page: 'https://grok.com/',
      // No package anyone at xAI publishes, on any platform. Opening the page
      // beats guessing at a lookalike.
    },
  },
  {
    id: 'slack', name: 'Slack', kind: 'electron',
    darwin: { bundles: ['Slack.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\slack\\app-*\\slack.exe', '%PROGRAMFILES%\\Slack\\slack.exe'] },
    linux: { desktop: ['slack', 'com.slack.Slack'], bins: ['slack'], flatpak: 'com.slack.Slack' },
    install: {
      page: 'https://slack.com/downloads',
      hosts: ['slack.com'],
      win32: { winget: 'SlackTechnologies.Slack', url: 'https://slack.com/ssb/download-win64' },
      darwin: { brew: 'slack' },
      linux: { flatpak: 'com.slack.Slack' },
    },
  },
  {
    id: 'discord', name: 'Discord', kind: 'electron',
    darwin: { bundles: ['Discord.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Discord\\app-*\\Discord.exe'] },
    linux: { desktop: ['discord', 'com.discordapp.Discord'], bins: ['discord'], flatpak: 'com.discordapp.Discord' },
    install: {
      page: 'https://discord.com/download',
      win32: { winget: 'Discord.Discord' },
      darwin: { brew: 'discord' },
      linux: { flatpak: 'com.discordapp.Discord' },
    },
  },
  {
    id: 'notion', name: 'Notion', kind: 'electron',
    darwin: { bundles: ['Notion.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\Notion\\Notion.exe'] },
    linux: { desktop: ['notion-app', 'notion'], bins: ['notion-app'] },
    install: {
      page: 'https://www.notion.com/desktop',
      win32: { winget: 'Notion.Notion' },
      darwin: { brew: 'notion' },
      linux: {}, // Notion ships no Linux build of its own
    },
  },
  {
    id: 'obsidian', name: 'Obsidian', kind: 'electron',
    darwin: { bundles: ['Obsidian.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.exe', '%LOCALAPPDATA%\\Obsidian\\Obsidian.exe'] },
    linux: { desktop: ['obsidian', 'md.obsidian.Obsidian'], bins: ['obsidian'], flatpak: 'md.obsidian.Obsidian' },
    install: {
      page: 'https://obsidian.md/download',
      win32: { winget: 'Obsidian.Obsidian' },
      darwin: { brew: 'obsidian' },
      linux: { flatpak: 'md.obsidian.Obsidian' },
    },
  },
  {
    id: 'vscode', name: 'Visual Studio Code', kind: 'electron',
    args: (p) => [`--extensions-dir=${path.join(p, 'extensions')}`],
    darwin: { bundles: ['Visual Studio Code.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%PROGRAMFILES%\\Microsoft VS Code\\Code.exe'] },
    linux: { desktop: ['code', 'com.visualstudio.code'], bins: ['code'], flatpak: 'com.visualstudio.code' },
    install: {
      page: 'https://code.visualstudio.com/download',
      win32: { winget: 'Microsoft.VisualStudioCode' },
      darwin: { brew: 'visual-studio-code' },
      linux: { flatpak: 'com.visualstudio.code' },
    },
  },
  {
    id: 'cursor', name: 'Cursor', kind: 'electron',
    args: (p) => [`--extensions-dir=${path.join(p, 'extensions')}`],
    darwin: { bundles: ['Cursor.app'] },
    win32: { paths: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'] },
    linux: { desktop: ['cursor'], bins: ['cursor'] },
    install: {
      page: 'https://cursor.com/downloads',
      win32: { winget: 'Anysphere.Cursor' },
      darwin: { brew: 'cursor' },
      linux: {},
    },
  },
  {
    id: 'chrome', name: 'Google Chrome', kind: 'chromium',
    darwin: { bundles: ['Google Chrome.app'] },
    win32: { paths: ['%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe', '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'] },
    linux: { desktop: ['google-chrome', 'com.google.Chrome'], bins: ['google-chrome', 'google-chrome-stable'], flatpak: 'com.google.Chrome' },
    install: {
      page: 'https://www.google.com/chrome/',
      win32: { winget: 'Google.Chrome' },
      darwin: { brew: 'google-chrome' },
      linux: { flatpak: 'com.google.Chrome' },
    },
  },
  {
    id: 'edge', name: 'Microsoft Edge', kind: 'chromium',
    darwin: { bundles: ['Microsoft Edge.app'] },
    win32: { paths: ['%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe'] },
    linux: { desktop: ['microsoft-edge', 'com.microsoft.Edge'], bins: ['microsoft-edge'], flatpak: 'com.microsoft.Edge' },
    install: {
      page: 'https://www.microsoft.com/edge/download',
      win32: { winget: 'Microsoft.Edge' },
      darwin: { brew: 'microsoft-edge' },
      linux: { flatpak: 'com.microsoft.Edge' },
    },
  },
  {
    id: 'brave', name: 'Brave', kind: 'chromium',
    darwin: { bundles: ['Brave Browser.app'] },
    win32: { paths: ['%PROGRAMFILES%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'] },
    linux: { desktop: ['brave-browser', 'com.brave.Browser'], bins: ['brave-browser', 'brave'], flatpak: 'com.brave.Browser' },
    install: {
      page: 'https://brave.com/download/',
      win32: { winget: 'Brave.Brave' },
      darwin: { brew: 'brave-browser' },
      linux: { flatpak: 'com.brave.Browser' },
    },
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
