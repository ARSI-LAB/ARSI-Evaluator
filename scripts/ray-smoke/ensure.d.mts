export declare function deploymentFingerprint(packageDigest: string, workspace?: string): Promise<string>;

export type ServiceState = {
  id: string;
  imageId: string;
  running: boolean;
  health: string | null;
  bundleDirectory?: string | null;
};

export declare function deploymentPlan(
  fingerprint: string,
  image: { id: string; fingerprint: string | null } | null,
  states: Record<string, ServiceState | undefined>,
  expectedBundleDirectory?: string | null,
): { build: boolean; ready: boolean; forceRecreate: boolean };

export declare function stageDeploymentBuildContext(workspace?: string): Promise<{ directory: string; dispose(): Promise<void> }>;
