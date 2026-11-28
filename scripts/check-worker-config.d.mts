export const configs: { engine: string; site: string };
export const defaultEngineName: string;

export function readConfig(
  path: string,
): Promise<{ text: string; config: Record<string, unknown> }>;

export function checkConfig(
  config: Record<string, unknown>,
  kind: string,
  source?: boolean,
  hyperdriveId?: string,
  engineName?: string,
): void;
