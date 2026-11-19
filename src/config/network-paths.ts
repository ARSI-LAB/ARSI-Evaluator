import { fileURLToPath } from "node:url";

export function recommendedNetworkConfigPath(): string {
  return fileURLToPath(new URL("../../playbook/network/mirrors.yaml", import.meta.url));
}
