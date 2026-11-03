import { readFile } from "node:fs/promises";
import { DockerEnvironment, DockerImageArchiveLoader, GitHubLfsSource, PINNED_NODE_IMAGE,
  checkedPath, runDockerCommand, withDatasetActivity } from "ember-evaluator";
import type { ActivityListener, DockerCommand, DockerEnvironmentOptions, EnvironmentSpec } from "ember-evaluator";
import { expectNonEmptyString, expectRecord, parseRepositoryConfig, rejectUnknown } from "./config.js";

const CLAUDE_TAG = "harbor-claude-code-base:2.1.114";
const CODEX_TAG = "harbor-codex-base:2.1.114";

export type DocOpsImageProfile = "amd" | "x86";

export type DocOpsDockerConfig = {
  profile: DocOpsImageProfile;
  repository: string;
  revision: string;
  cacheDir: string;
  dockerExecutable?: string;
  nodeImage?: string;
};

export type DocOpsImageTransport = {
  apiBase: string;
  lfsBase: string;
};

const defaultTransport: DocOpsImageTransport = {
  apiBase: "https://api.github.com",
  lfsBase: "https://github.com",
};

function archivePath(profile: DocOpsImageProfile, tag: string): string {
  if (tag === CLAUDE_TAG) return `docker/images/${profile}/harbor-claude-code-base_2.1.114_linux-amd64.tar.gz`;
  if (tag === CODEX_TAG && profile === "amd") return "docker/images/amd/harbor-codex-base_2.1.114_linux-amd64.tar.gz";
  if (tag === CODEX_TAG && profile === "x86") return "docker/images/x86/harbor-codex080-chat-base_0.80.0_linux-amd64.tar.gz";
  throw new TypeError(`Unsupported DocOps base image: ${tag}`);
}

function requiredImages(dockerfile: string): string[] {
  const found = new Set<string>();
  for (const line of dockerfile.split(/\r?\n/u)) {
    const image = /^\s*FROM(?:\s+--platform=\S+)?\s+([^\s]+)(?:\s+AS\s+\S+)?\s*$/iu.exec(line)?.[1];
    if (image === CLAUDE_TAG || image === CODEX_TAG) found.add(image);
  }
  return [...found];
}

export function parseDocOpsDockerConfig(value: unknown): DocOpsDockerConfig {
  const config = expectRecord(value, "docops-docker");
  rejectUnknown(config, ["profile", "repository", "revision", "cacheDir", "dockerExecutable", "nodeImage"], "docops-docker");
  const profile = config.profile ?? "amd";
  if (profile !== "amd" && profile !== "x86") throw new TypeError("docops-docker.profile must be amd or x86");
  const { repository, revision } = parseRepositoryConfig(config, "docops-docker");
  const dockerExecutable = config.dockerExecutable === undefined ? undefined : expectNonEmptyString(config.dockerExecutable, "docops-docker.dockerExecutable");
  const nodeImage = config.nodeImage === undefined ? undefined : expectNonEmptyString(config.nodeImage, "docops-docker.nodeImage");
  if (nodeImage !== undefined && nodeImage !== PINNED_NODE_IMAGE) {
    throw new TypeError(`docops-docker.nodeImage must equal the pinned runtime image ${PINNED_NODE_IMAGE}`);
  }
  return {
    profile,
    repository,
    revision,
    cacheDir: expectNonEmptyString(config.cacheDir ?? ".cache/docops-images", "docops-docker.cacheDir"),
    ...(dockerExecutable === undefined ? {} : { dockerExecutable }),
    ...(nodeImage === undefined ? {} : { nodeImage }),
  };
}

export class DocOpsImageProvider {
  private readonly source: GitHubLfsSource;
  private readonly images: DockerImageArchiveLoader;

  constructor(
    private readonly config: DocOpsDockerConfig,
    command: DockerCommand,
    transport: DocOpsImageTransport = defaultTransport,
  ) {
    this.source = new GitHubLfsSource(config, transport);
    this.images = new DockerImageArchiveLoader(command);
  }

  async ensureForSpec(spec: EnvironmentSpec, signal: AbortSignal, activity?: ActivityListener): Promise<void> {
    signal.throwIfAborted();
    if (!spec.build) return;
    const dockerfile = await readFile(await checkedPath(spec.build.context, spec.build.dockerfile), "utf8");
    await withDatasetActivity(activity, async () => {
      for (const tag of requiredImages(dockerfile)) {
        const aliases = tag === CODEX_TAG && this.config.profile === "x86"
          ? ["harbor-codex080-chat-base:0.80.0-amd64", "harbor-codex080-chat-base:0.80.0"]
          : [`${tag}-amd64`, `${tag}-linux-amd64`];
        await this.images.ensure(tag, {
          archive: (active, observe) => withDatasetActivity(observe, () => this.source.fetch(archivePath(this.config.profile, tag), active)), aliases,
        }, signal, activity);
      }
    });
  }
}

// Inherit all environment operations; only the image mapping belongs to DocOps.
export class DocOpsDockerEnvironment extends DockerEnvironment {
  constructor(config: DocOpsDockerConfig, transport: DocOpsImageTransport = defaultTransport, command?: DockerCommand,
    runtime: Pick<DockerEnvironmentOptions, "modelEndpoint" | "onWarning"> = {}) {
    const selectedCommand = command ?? ((args, options) => runDockerCommand(config.dockerExecutable ?? "docker", args, options));
    const provider = new DocOpsImageProvider(config, selectedCommand, transport);
    super({
      ...runtime,
      ...(config.dockerExecutable === undefined ? {} : { dockerExecutable: config.dockerExecutable }),
      ...(config.nodeImage === undefined ? {} : { nodeImage: config.nodeImage }),
      prepareBuild: (spec, signal, activity) => provider.ensureForSpec(spec, signal, activity),
    });
  }
}
