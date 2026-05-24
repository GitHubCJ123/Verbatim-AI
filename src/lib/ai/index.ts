/**
 * Provider resolver + config persistence.
 *
 * Azure credentials live in localStorage for now. Plan §16 requires
 * moving the API key into the OS keyring (`tauri-plugin-keyring`) —
 * deferred to a later phase. Endpoint / deployment names are not
 * secrets and can stay in localStorage long-term.
 *
 * SECURITY NOTE (acknowledged temporary): an API key in localStorage
 * is accessible to any JS that runs in the main window. Since SuperWisper
 * is a single-tenant desktop app with no remote code execution this is
 * acceptable for development.
 */
import type { AIProvider } from "./AIProvider";
import { AzureFoundryProvider, type AzureConfig } from "./AzureFoundryProvider";

const LS_KEY = "sw.azure.config";

export type AzureConfigInput = Partial<AzureConfig>;

export function loadAzureConfig(): AzureConfigInput {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as AzureConfigInput;
  } catch {
    return {};
  }
}

export function saveAzureConfig(cfg: AzureConfigInput): void {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

export function isConfigured(cfg: AzureConfigInput): cfg is AzureConfig {
  return Boolean(
    cfg.endpoint && cfg.apiKey && cfg.transcribeDeployment && cfg.cleanupDeployment,
  );
}

export function getActiveProvider(): AIProvider | null {
  const cfg = loadAzureConfig();
  if (!isConfigured(cfg)) return null;
  return new AzureFoundryProvider(cfg);
}

export { AzureFoundryProvider };
export type { AzureConfig };
