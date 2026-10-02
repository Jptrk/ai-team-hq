/**
 * Ready-made MCP servers for the Add connection screen. The server rebuilds the command from
 * these, so a package name or flag never comes from the browser.
 */

export interface PresetChoice {
  value: string;
  label: string;
}

export interface PresetOption {
  id: string;
  label: string;
  hint?: string;
  /** flag: on adds `flag`; choice: adds `flag value`. */
  kind: 'flag' | 'choice';
  flag: string;
  choices?: PresetChoice[];
  default: boolean | string;
}

export interface McpPreset {
  id: string;
  title: string;
  blurb: string;
  defaultName: string;
  command: string;
  baseArgs: string[];
  options: PresetOption[];
  docsUrl: string;
}

export type PresetValues = Record<string, string | boolean>;

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'playwright',
    title: 'Playwright',
    blurb: 'A real browser desks can drive: open pages, click, fill forms, take screenshots.',
    defaultName: 'playwright',
    command: 'npx',
    baseArgs: ['-y', '@playwright/mcp@latest'],
    options: [
      { id: 'headless', label: 'Run without a window', hint: 'Off shows the browser on your screen while a desk uses it.', kind: 'flag', flag: '--headless', default: true },
      { id: 'isolated', label: 'Fresh browser each time', hint: 'Nothing is saved between runs, so no logins carry over.', kind: 'flag', flag: '--isolated', default: true },
      {
        id: 'browser',
        label: 'Browser',
        kind: 'choice',
        flag: '--browser',
        choices: [
          { value: 'chrome', label: 'Chrome' },
          { value: 'msedge', label: 'Edge' },
        ],
        default: 'chrome',
      },
    ],
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'chrome-devtools',
    title: 'Chrome DevTools',
    blurb: 'Chrome with its developer tools: pages, console, network, performance, screenshots.',
    defaultName: 'chrome-devtools',
    command: 'npx',
    baseArgs: ['-y', 'chrome-devtools-mcp@latest'],
    options: [
      { id: 'headless', label: 'Run without a window', hint: 'Off shows Chrome on your screen while a desk uses it.', kind: 'flag', flag: '--headless', default: true },
      { id: 'isolated', label: 'Fresh browser each time', hint: 'A temporary profile, deleted when the browser closes.', kind: 'flag', flag: '--isolated', default: true },
    ],
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
];

export function presetById(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id);
}

/** Defaults for a preset's options. */
export function presetDefaults(preset: McpPreset): PresetValues {
  return Object.fromEntries(preset.options.map((o) => [o.id, o.default]));
}

/** The preset's arguments with these option values. Unknown options and values are ignored. */
export function presetArgs(preset: McpPreset, values: PresetValues): string[] {
  const args = [...preset.baseArgs];
  for (const o of preset.options) {
    const v = o.id in values ? values[o.id] : o.default;
    if (o.kind === 'flag') {
      if (v === true) args.push(o.flag);
    } else {
      const pick = o.choices?.find((c) => c.value === v) ?? o.choices?.find((c) => c.value === o.default);
      if (pick) args.push(o.flag, pick.value);
    }
  }
  return args;
}
