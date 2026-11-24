/**
 * Install, remove and switch the built-in speech models. Shared by the model
 * list and the on-device benchmark so both follow the same rules.
 */
import {
  deleteLocalModel,
  downloadLocalModel,
  installWhisperRuntime,
  isWhisperRuntimeInstalled,
  listLocalModels,
  resetWhisperEngineProbe,
  setAiProviderKind,
  setLocalWhisperTier,
  unloadWhisperEngine,
  type WhisperTier,
} from "./localWhisper";
import {
  CANARY_LANGUAGES,
  deleteParakeetModel,
  downloadParakeetModel,
  getParakeetLanguage,
  installParakeetRuntime,
  isParakeetRuntimeInstalled,
  listParakeetModels,
  setParakeetVariant,
} from "./parakeet";
import { prewarmEngines } from "./index";
import type { SpeechChoice, SpeechInstallState } from "./speechChoices";

/** Window event fired when models are installed, removed or switched elsewhere. */
export const SPEECH_MODELS_CHANGED = "verbatim:speech-models-changed";

export function notifySpeechModelsChanged(): void {
  window.dispatchEvent(new Event(SPEECH_MODELS_CHANGED));
}

export async function readSpeechInstallState(): Promise<SpeechInstallState> {
  const [wr, wm, pr, pm] = await Promise.all([
    isWhisperRuntimeInstalled(),
    listLocalModels(),
    isParakeetRuntimeInstalled(),
    listParakeetModels(),
  ]);
  return {
    whisperRuntime: wr,
    whisperTiers: Object.fromEntries(wm.map((m) => [m.tier, m.installed])),
    parakeetRuntime: pr,
    parakeetVariants: Object.fromEntries(pm.map((m) => [m.variant, m.installed])),
  };
}

export async function installSpeechRuntime(engine: SpeechChoice["engine"]): Promise<void> {
  if (engine === "local-parakeet") return installParakeetRuntime();
  await installWhisperRuntime();
  resetWhisperEngineProbe();
}

export function downloadSpeechModel(c: SpeechChoice): Promise<void> {
  return c.engine === "local-parakeet"
    ? downloadParakeetModel(c.variant ?? "v3")
    : downloadLocalModel((c.tier ?? "turbo") as WhisperTier);
}

/** Delete a model's files, first stopping any server holding them open. */
export async function uninstallSpeechChoice(c: SpeechChoice): Promise<void> {
  if (c.engine === "local-parakeet") return deleteParakeetModel(c.variant ?? "v3");
  await unloadWhisperEngine();
  await deleteLocalModel(c.tier ?? "turbo");
}

/** Canary can't detect the language; it needs a supported saved language. */
export function speechChoiceLanguageOk(c: SpeechChoice, language = getParakeetLanguage()): boolean {
  return !c.needsLanguage || (CANARY_LANGUAGES as readonly string[]).includes(language);
}

/** Make `c` the active model and load it so the next dictation is fast. */
export function applySpeechChoice(c: SpeechChoice): void {
  if (c.engine === "local-parakeet") {
    setParakeetVariant(c.variant ?? "v3");
  } else {
    setLocalWhisperTier(c.tier ?? "turbo");
  }
  setAiProviderKind(c.engine);
  resetWhisperEngineProbe();
  prewarmEngines(null);
}
