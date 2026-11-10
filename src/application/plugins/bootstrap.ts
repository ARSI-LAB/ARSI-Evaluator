import type { LoadedConfig } from "../../config/loaded.js";
import type { RunComponents } from "../../core/contracts/components.js";
import { createRunComponents, type RunComponentOptions } from "./create-components.js";
import { openPluginRegistry } from "./open-registry.js";

export type BootstrappedComponents = RunComponents & { dispose(): Promise<void> };

/** Open an independent registry. The returned dispose releases all of its resources. */
export async function bootstrap(
  config: LoadedConfig,
  experimentDir: string,
  patchPath?: string,
  onWarning?: (message: string) => void,
  imageConfigFingerprint?: string,
  options: RunComponentOptions = {},
): Promise<BootstrappedComponents> {
  const registry = await openPluginRegistry(patchPath,
    options.plugins === undefined ? {} : { plugins: options.plugins.map(plugin => plugin.id) });
  try {
    const components = await createRunComponents(registry, config, experimentDir, onWarning, imageConfigFingerprint, options);
    return { ...components, dispose: () => registry.dispose() };
  } catch (error) {
    await registry.dispose();
    throw error;
  }
}
