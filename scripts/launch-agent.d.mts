export interface LaunchAgentOptions {
  label?: string; checkout?: string; agentDirectory?: string; logDirectory?: string; config?: string; path?: string;
}
export function renderLaunchAgent(template: string, values: Record<string, string>): string;
export function install(options?: LaunchAgentOptions, run?: (args: string[]) => string): string;
export function uninstall(options?: LaunchAgentOptions, run?: (args: string[]) => string): void;
