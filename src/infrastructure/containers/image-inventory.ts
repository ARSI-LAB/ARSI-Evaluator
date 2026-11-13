import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { DockerCommand } from "./runtime-contract.js";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import type { ImageCleanupRequest, ImageCleanupNode, ImageCleanupItem } from "../../core/contracts/image-cleanup.js";
import { DockerEnvironmentError } from "./error.js";
import { dockerImageReference } from "./image-name.js";
import { imageReference } from "./registry-image.js";
import { acquireRuntimeLock } from "../runtime-installation/lock.js";
import { applicationCacheRoot } from "../runtime-installation/install.js";

type Owner = { configFingerprint: string; taskId: string; phase: string };
type ImageSource = { reference: string; id: string };
type ImageKey = { key: string; digest: string; source?: ImageSource };
type Entry = { reference: string; id: string; owned: boolean; owners: Owner[]; dependencies: string[]; keys?: ImageKey[]; retained?: true; buildInput?: true };
type Lease = { token: string; pid: number; host: string; runOwner?: string };
type Inventory = { schemaVersion: 1; daemonId: string; inventoryId: string; entries: Entry[]; leases: Lease[] };
type Scope = { owner?: Owner; touched: Set<string>; seen: Set<string>; token: string; lease?: Promise<() => Promise<void>> };
type RetentionOptions = { key?: string; source?: ImageSource; preferred?: string; removeAlias?: boolean; temporary?: boolean; buildInput?: boolean; acquiredInput?: boolean };
const namespace = "ember-evaluator/";
const managed = (reference: string) => reference.startsWith(namespace) || /^ember-harbor-verifier:[a-f0-9]{24}$/u.test(reference);
const legacyOwned = (reference: string) => managed(reference) && !/:linux-(?:amd64|arm64)-/u.test(reference);
const digest = /^sha256:[a-f0-9]{64}$/u;
const absent = (error: unknown) => error instanceof Error && /no such (?:image|object)|not found/iu.test(error.message);
const staging = (reference: string) => reference.startsWith("ember-evaluator/staging:");
const legacy = (reference: string) => reference.startsWith("ember-evaluator/shared:") || reference.startsWith("ember-evaluator/pull:") ||
  /^ember-harbor-verifier:[a-f0-9]{24}$/u.test(reference);
const replaceable = (entry: Entry) => entry.owned && !entry.buildInput && (legacy(entry.reference) || !managed(entry.reference));

function activeLease(lease: Lease): boolean {
  if (lease.host !== hostname()) return true;
  try { process.kill(lease.pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}

function referenceIdentity(reference: string): string {
  if (digest.test(reference)) return reference;
  const { registry, repository, selector, digest: pinned } = imageReference(reference);
  return `${registry}/${repository}${pinned ? "@" : ":"}${selector}`;
}

/** Persist references, rather than deleting image IDs which may have foreign aliases. */
export class DockerImageInventory {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private identity: Promise<{ id: string; path: string }> | undefined;
  constructor(private readonly raw: DockerCommand, private readonly root = join(process.env.EVALUATOR_CACHE_DIR ?? applicationCacheRoot(), "docker-images")) {}

  private location(signal: AbortSignal) {
    return this.identity ??= (async () => {
      const id = (await this.raw(["info", "--format", "{{.ID}}"], { signal })).stdout.trim();
      if (!id || /[\u0000-\u001f]/u.test(id)) throw new Error("Docker daemon identity is unavailable");
      return { id, path: join(this.root, createHash("sha256").update(id).digest("hex") + ".json") };
    })().catch(error => { this.identity = undefined; throw error; });
  }
  private async read(path: string, daemonId: string): Promise<{ data: Inventory; missing: boolean }> {
    let data: unknown;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe image inventory file");
      data = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {
        data: { schemaVersion: 1, daemonId, inventoryId: randomUUID(), entries: [], leases: [] }, missing: true,
      };
      throw error;
    }
    if (!data || typeof data !== "object" || !("schemaVersion" in data) || data.schemaVersion !== 1 || !("daemonId" in data) || data.daemonId !== daemonId ||
      !("inventoryId" in data) || typeof data.inventoryId !== "string" || !data.inventoryId ||
      !("entries" in data) || !Array.isArray(data.entries) || !("leases" in data) || !Array.isArray(data.leases)) throw new Error("Invalid image inventory");
    for (const entry of data.entries) {
      if (!entry || typeof entry.reference !== "string" || !entry.reference || /[\s\u0000-\u001f]/u.test(entry.reference) || entry.reference.startsWith("-") ||
        typeof entry.id !== "string" || !digest.test(entry.id) || typeof entry.owned !== "boolean" || !Array.isArray(entry.owners) ||
        !entry.owners.every((owner: unknown) => validOwner(owner)) || !Array.isArray(entry.dependencies) || !entry.dependencies.every((id: unknown) => typeof id === "string" && digest.test(id))) throw new Error("Invalid image inventory entry");
      if (entry.keys !== undefined && (!Array.isArray(entry.keys) || !entry.keys.every((item: ImageKey) =>
        item && typeof item.key === "string" && typeof item.digest === "string" && digest.test(item.digest) &&
        (item.source === undefined || item.source && typeof item.source.reference === "string" && digest.test(item.source.id))))) throw new Error("Invalid image inventory key");
      // Older inventories stored one owner per task and phase. Cleanup selects by configuration.
      if (entry.owners.length > 1) {
        const configs = new Set<string>();
        entry.owners = entry.owners.filter((owner: Owner) => {
          if (configs.has(owner.configFingerprint)) return false;
          configs.add(owner.configFingerprint);
          return true;
        });
      }
    }
    for (const lease of data.leases) if (!lease || typeof lease.token !== "string" || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || typeof lease.host !== "string") throw new Error("Invalid image inventory lease");
    return { data: data as Inventory, missing: false };
  }
  private async save(path: string, data: Inventory) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(data) + "\n", { flag: "wx", mode: 0o600 }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  }
  private async edit<T>(signal: AbortSignal, action: (data: Inventory) => Promise<T> | T, save = true): Promise<T> {
    const { id, path } = await this.location(signal);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const release = await acquireRuntimeLock(`${path}.lock`, signal);
    try {
      const { data, missing } = await this.read(path, id);
      // An empty identity receipt lets nodes on a shared cache recognize the
      // same daemon during their first preview, without recording associations.
      if (missing && !save) await this.save(path, data);
      const result = await action(data);
      if (save) await this.save(path, data);
      return result;
    } finally { await release(); }
  }
  async lease(signal: AbortSignal, token: string = randomUUID(), runOwner?: string): Promise<() => Promise<void>> {
    await this.edit(signal, data => { data.leases.push({ token, pid: process.pid, host: hostname(), ...(runOwner ? { runOwner } : {}) }); });
    let released = false;
    return async () => {
      if (released) return;
      await this.edit(AbortSignal.timeout(10_000), data => { data.leases = data.leases.filter(lease => lease.token !== token); });
      released = true;
    };
  }
  async withSource<T>(source: string, platform: ContainerPlatform, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const { path } = await this.location(signal);
    const key = createHash("sha256").update(JSON.stringify([source, platform])).digest("hex");
    const release = await acquireRuntimeLock(join(dirname(path), "sources", `${key}.lock`), signal);
    try { return await action(); } finally { await release(); }
  }
  async use<T>(owner: Owner | undefined, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const held = await this.hold(owner, signal, action);
    try { return held.value; } finally { await held.release(); }
  }
  async hold<T>(owner: Owner | undefined, signal: AbortSignal, action: (release: () => Promise<void>) => Promise<T>) {
    signal.throwIfAborted();
    const scope: Scope = { ...(owner ? { owner } : {}), touched: new Set(), seen: new Set(), token: randomUUID() };
    const release = async () => { if (scope.lease) await (await scope.lease)(); };
    try { return { value: await this.scope.run(scope, () => action(release)), release }; }
    catch (error) {
      try { await release(); }
      catch (cleanup) {
        if (cleanup !== error) throw new DockerEnvironmentError("CLEANUP_FAILED", "Failed to release Docker image lease", new AggregateError([error, cleanup]));
      }
      throw error;
    }
  }
  private async inspect(reference: string, signal: AbortSignal): Promise<{ id: string; tags: string[]; digests: string[] } | undefined> {
    try {
      const raw = JSON.parse((await this.raw(["image", "inspect", reference, "--format", "[{{json .Id}},{{json .RepoTags}},{{json .RepoDigests}}]"], { signal })).stdout) as unknown;
      if (!Array.isArray(raw) || typeof raw[0] !== "string" || !digest.test(raw[0]) || ![raw[1], raw[2]].every(value => value === null || Array.isArray(value) && value.every(item => typeof item === "string")))
        throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Invalid Docker image identity for ${reference}`);
      return { id: raw[0], tags: raw[1] ?? [], digests: raw[2] ?? [] };
    } catch (error) { signal.throwIfAborted(); if (absent(error)) return undefined; throw error; }
  }
  private async observe(reference: string, signal: AbortSignal, acquired = false, dependencies?: string[]) {
    const scope = this.scope.getStore();
    if (!scope) return;
    if (!acquired && !dependencies && (scope.seen.has(reference) || digest.test(reference) && scope.touched.has(reference))) return;
    const image = await this.inspect(reference, signal);
    if (!image) return;
    await this.edit(signal, data => {
      let entry = data.entries.find(entry => entry.reference === reference);
      if (entry && entry.id !== image.id) {
        // A moved external tag is never evidence that its new content is ours.
        entry.id = image.id; entry.owned = acquired || legacyOwned(reference); entry.owners = []; entry.dependencies = [];
        delete entry.keys;
        delete entry.retained;
        delete entry.buildInput;
      }
      if (!entry && !digest.test(reference)) { entry = { reference, id: image.id, owned: acquired || legacyOwned(reference), owners: [], dependencies: [] }; data.entries.push(entry); }
      if (entry) {
        entry.owned ||= acquired;
        if (dependencies) entry.dependencies = [...new Set(dependencies)].filter(id => id !== image.id);
      }
      const owner = scope.owner;
      const associate = (record: Entry) => {
        if (owner && !record.owners.some(value => value.configFingerprint === owner.configFingerprint)) record.owners.push(owner);
      };
      if (entry) associate(entry);
      const ids = new Set([image.id, ...(entry?.dependencies ?? [])]);
      // Include dependencies even when runtime and solver caches bypass Docker.
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of data.entries) if (ids.has(record.id)) {
          associate(record);
          for (const id of record.dependencies) if (!ids.has(id)) { ids.add(id); changed = true; }
        }
      }
    });
    scope.touched.add(image.id);
    scope.seen.add(reference);
  }

  private async platformDigest(reference: string, platform: ContainerPlatform, signal: AbortSignal): Promise<string> {
    const { stdout } = await this.raw(["image", "inspect", "--platform", platform, reference, "--format",
      "[{{json .Id}},{{json .Os}},{{json .Architecture}}]"], { signal });
    const value: unknown = JSON.parse(stdout);
    if (!Array.isArray(value) || typeof value[0] !== "string" || !digest.test(value[0]))
      throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Invalid image identity for ${reference}`);
    if (`${value[1]}/${value[2]}` !== platform)
      throw new DockerEnvironmentError("ENV_ARCH_UNSUPPORTED", `Image ${reference} does not match ${platform}`);
    return value[0];
  }

  async cached(key: string, platform: ContainerPlatform, signal: AbortSignal, preferred?: string) {
    const scope = this.scope.getStore();
    if (preferred && scope) {
      scope.lease ??= this.lease(signal, scope.token);
      await scope.lease;
    }
    const found = await this.edit(signal, data => data.entries.find(entry => entry.keys?.some(item => item.key === key)), false);
    const record = found?.keys?.find(item => item.key === key);
    if (!found || !record) return undefined;
    let reference = found.reference;
    let image = await this.inspect(reference, signal);
    if (!image && replaceable(found)) {
      const byId = await this.inspect(found.id, signal);
      const recovered = byId?.tags.find(tag => managed(tag) && !legacy(tag) && !staging(tag));
      if (recovered && await this.platformDigest(recovered, platform, signal) === record.digest) {
        await this.edit(signal, data => {
          const old = data.entries.find(entry => entry.reference === found.reference && entry.id === found.id);
          if (old) {
            const current = data.entries.find(entry => entry.reference === recovered && entry.id === old.id);
            if (current) { this.mergeReferences(current, old); data.entries = data.entries.filter(entry => entry !== old); }
            else old.reference = recovered;
          }
        });
        reference = recovered;
        image = byId;
      }
    }
    if (!image) return undefined;
    if (image.id !== found.id || await this.platformDigest(reference, platform, signal) !== record.digest)
      throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Cached image reference changed: ${found.reference}`);
    if (preferred && replaceable(found) && reference === found.reference) {
      const retained = await this.retain(reference, platform, signal, { preferred });
      reference = retained.reference;
    }
    await this.observe(reference, signal);
    return { reference, id: image.id, digest: record.digest, source: record.source };
  }

  async markRetained(reference: string, id: string, signal: AbortSignal): Promise<void> {
    await this.edit(signal, data => {
      const entry = data.entries.find(item => item.reference === reference && item.id === id);
      if (!entry) throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Missing retained image reference: ${reference}`);
      entry.retained = true;
    });
    await this.observe(reference, signal);
  }

  private mergeReferences(target: Entry, source: Entry) {
    target.dependencies = [...new Set([...target.dependencies, ...source.dependencies])];
    for (const owner of source.owners)
      if (!target.owners.some(item => item.configFingerprint === owner.configFingerprint)) target.owners.push(owner);
    for (const item of source.keys ?? []) {
      target.keys ??= [];
      if (!target.keys.some(value => value.key === item.key)) target.keys.push(item);
    }
  }

  private async containerImages(signal: AbortSignal) {
    const containers = (await this.raw(["ps", "--all", "--quiet", "--no-trunc"], { signal })).stdout.trim().split(/\s+/u).filter(Boolean);
    const images = new Set<string>();
    for (const container of containers) {
      if (!/^[a-f0-9]{12,64}$/u.test(container)) throw new Error("Invalid Docker container identity");
      images.add((await this.raw(["container", "inspect", container, "--format", "{{.Image}}"], { signal })).stdout.trim());
    }
    return images;
  }

  /** Publish one retained reference. Only caller-owned aliases may be removed. */
  async retain(reference: string, platform: ContainerPlatform, signal: AbortSignal,
    options: RetentionOptions = {}) {
    const platformId = await this.platformDigest(reference, platform, signal);
    const result = await this.edit(signal, async data => {
      const image = await this.inspect(reference, signal);
      if (!image) throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Image disappeared: ${reference}`);
      const source = data.entries.find(entry => entry.reference === reference && entry.id === image.id);
      const sourceName = referenceIdentity(reference);
      const retained = data.entries.filter(entry => entry.id === image.id && entry.retained);
      const candidates = options.removeAlias || options.temporary || digest.test(reference) || options.preferred
        ? [...new Set([...retained.map(entry => entry.reference), ...image.tags])].filter(candidate =>
          referenceIdentity(candidate) !== sourceName && !candidate.startsWith("ember-evaluator/staging:") &&
          !data.entries.some(entry => entry.reference === candidate && entry.id === image.id && entry.buildInput && !entry.retained)) : [];
      let selected: string | undefined;
      for (const candidate of candidates) {
        if (!image.tags.includes(candidate) && (await this.inspect(candidate, signal))?.id !== image.id) continue;
        const candidateId = await this.platformDigest(candidate, platform, signal).catch(error => {
          signal.throwIfAborted();
          if (absent(error) || error instanceof DockerEnvironmentError && error.code === "ENV_ARCH_UNSUPPORTED") return undefined;
          throw error;
        });
        if (candidateId === platformId) {
          selected = candidate;
          break;
        }
      }
      const original = selected ?? reference;
      const originalEntry = data.entries.find(entry => entry.reference === original && entry.id === image.id);
      const previous = source && legacy(reference) && replaceable(source) ? source :
        originalEntry && replaceable(originalEntry) && (legacy(original) || originalEntry.retained) ? originalEntry : undefined;
      const previousName = previous?.reference;
      const scope = this.scope.getStore();
      const others = previousName ? data.leases.filter(lease => lease.token !== scope?.token && activeLease(lease)) : [];
      const sameRun = others.length === 1 && scope?.owner && others.some(lease =>
        lease.host === hostname() && lease.pid === process.pid && lease.runOwner === scope.owner?.configFingerprint);
      const removable = (alias: string) => {
        const name = referenceIdentity(alias);
        return alias.includes("@") ? !image.tags.some(tag => {
          const candidate = referenceIdentity(tag);
          return candidate.slice(0, candidate.lastIndexOf(":")) === name.split("@")[0];
        }) : image.tags.some(tag => referenceIdentity(tag) === name);
      };
      const canRename = options.preferred && previousName && (legacy(previousName) || !previousName.includes("@")) &&
        removable(previousName) && (others.length === 0 || sameRun) &&
        !(await this.containerImages(signal)).has(image.id);
      const preferred = options.preferred ?? dockerImageReference(platform, "base");
      const preservedTag = canRename && selected && selected !== previousName ? selected : undefined;
      const publish = !options.buildInput && !preservedTag && (canRename || !selected && !previousName &&
        (options.temporary || digest.test(reference) || options.preferred && (source?.owned || managed(reference)) && removable(reference)));
      selected = preservedTag || original;
      let created = false;
      if (publish) {
        for (let suffix = 1; ; suffix++) {
          const ending = `-${suffix}`;
          const name = suffix === 1 ? preferred : `${preferred.slice(0, preferred.lastIndexOf(":") + 129 - ending.length)}${ending}`;
          const existing = await this.inspect(name, signal);
          if (existing && existing.id !== image.id) continue;
          if (!existing) {
            await this.raw(["image", "tag", image.id, name], { signal });
            created = true;
          }
          selected = name;
          break;
        }
      } else if (options.buildInput && (options.temporary || digest.test(reference)) && selected === reference) {
        selected = `ember-evaluator/staging:${randomUUID()}`;
        await this.raw(["image", "tag", image.id, selected], { signal });
      }
      if (await this.platformDigest(selected, platform, signal) !== platformId || (await this.inspect(selected, signal))?.id !== image.id)
        throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Image identity changed: ${selected}`);
      let entry = data.entries.find(item => item.reference === selected && item.id === image.id);
      if (!entry) {
        entry = { reference: selected, id: image.id, owned: created || legacyOwned(selected), owners: [], dependencies: [] };
        if (options.buildInput && options.temporary && selected.startsWith("ember-evaluator/staging:")) entry.buildInput = true;
        data.entries = data.entries.filter(item => item.reference !== selected);
        data.entries.push(entry);
      }
      if (!options.buildInput) entry.retained = true;
      else if (options.acquiredInput && selected === reference) entry.buildInput = true;
      if (source && source !== entry) this.mergeReferences(entry, source);
      if (options.key) {
        for (const item of data.entries) if (item.keys) item.keys = item.keys.filter(value => value.key !== options.key);
        (entry.keys ??= []).push({ key: options.key, digest: platformId, ...(options.source ? { source: options.source } : {}) });
      }
      if (canRename && previousName && selected !== previousName) {
        if (previous) this.mergeReferences(entry, previous);
        try { await this.raw(["image", "rm", "--no-prune", previousName], { signal }); }
        catch (error) {
          const active = AbortSignal.timeout(15_000);
          if (created && (await this.inspect(previousName, active))?.id === image.id &&
            (await this.inspect(selected, active))?.id === image.id)
            await this.raw(["image", "rm", "--no-prune", selected], { signal: active });
          throw error;
        }
        data.entries = data.entries.filter(item => item !== previous);
      }
      if (selected !== reference && (!canRename || reference !== previousName) &&
        (options.temporary || (options.removeAlias || publish) && (source?.owned || managed(reference)) && !source?.retained && removable(reference))) {
        await this.raw(["image", "rm", "--no-prune", reference], { signal });
        data.entries = data.entries.filter(item => item.reference !== reference || item.id !== image.id);
      }
      return { reference: selected, id: image.id, digest: platformId };
    });
    await this.observe(result.reference, signal);
    return result;
  }

  async releaseBuildInput(reference: string, id: string, signal: AbortSignal): Promise<void> {
    await this.edit(signal, async data => {
      const entry = data.entries.find(item => item.reference === reference && item.id === id);
      if (!entry?.owned || entry.retained || !entry.buildInput) return;
      const image = await this.inspect(reference, signal);
      if (!image || image.id !== id) return;
      // Docker can remove a registry digest together with tags from that repository.
      if (reference.includes("@") && image.tags.length) return;
      try { await this.raw(["image", "rm", "--no-prune", reference], { signal }); }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && /conflict[^\n]*used by[^\n]*container/iu.test(error.message)) return;
        throw error;
      }
      data.entries = data.entries.filter(item => item !== entry);
    });
  }

  async discardStaging(reference: string, signal: AbortSignal): Promise<void> {
    if (!reference.startsWith("ember-evaluator/staging:")) throw new Error("Expected a staging image reference");
    await this.edit(signal, async data => {
      if (await this.inspect(reference, signal)) await this.raw(["image", "rm", "--no-prune", reference], { signal });
      data.entries = data.entries.filter(entry => entry.reference !== reference);
    });
  }
  readonly command: DockerCommand = async (args, options) => {
    const scope = this.scope.getStore();
    if (!scope || args[0] === "info" || args[0] === "version") return this.raw(args, options);
    const signal = options?.signal ?? AbortSignal.timeout(60_000);
    scope.lease ??= this.lease(signal, scope.token);
    await scope.lease;
    const pull = args[0] === "pull" ? args.at(-1) : undefined;
    let absentBeforePull = false;
    if (pull) {
      try { absentBeforePull = await this.inspect(pull, signal) === undefined; }
      catch { signal.throwIfAborted(); /* Unknown prior ownership never authorizes source deletion. */ }
    }
    const result = await this.raw(args, options);
    const tagIndex = args.indexOf("--tag");
    const reference = pull ?? (args[0] === "build" && tagIndex >= 0 ? args[tagIndex + 1] :
      args[0] === "image" && args[1] === "tag" ? args[3] : undefined);
    if (reference) await this.observe(reference, signal, Boolean(pull && absentBeforePull), args[0] === "build" ? await this.buildDependencies(args, signal) : undefined);
    else if (args[0] === "image" && args[1] === "inspect") {
      const end = args.indexOf("--format");
      const refs = args.slice(2, end < 0 ? undefined : end).filter((arg, index, values) => !arg.startsWith("--") && values[index - 1] !== "--platform");
      for (const ref of refs) await this.observe(ref, signal);
    }
    return result;
  };

  private async buildDependencies(args: string[], signal: AbortSignal): Promise<string[]> {
    const argsByName = new Map<string, string>();
    for (let index = 0; index < args.length; index++) if (args[index] === "--build-arg") {
      const value = args[index + 1] ?? "", separator = value.indexOf("=");
      if (separator > 0) argsByName.set(value.slice(0, separator), value.slice(separator + 1));
    }
    const fileIndex = Math.max(args.indexOf("--file"), args.indexOf("-f"));
    const file = fileIndex < 0 ? join(args.at(-1)!, "Dockerfile") : args[fileIndex + 1]!;
    const dockerfile = await readFile(file, "utf8");
    const stages = new Set<string>(), dependencies: string[] = [];
    for (const line of dockerfile.split(/\r?\n/u)) {
      const argument = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/iu.exec(line);
      if (argument && !argsByName.has(argument[1]!)) argsByName.set(argument[1]!, argument[2]!.trim());
      const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/iu.exec(line);
      if (!match) continue;
      const image = match[1]!.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_, first: string, second: string) => argsByName.get(first ?? second) ?? "");
      if (image && !image.includes("$") && image !== "scratch" && !stages.has(image.toLowerCase())) {
        const found = await this.inspect(image, signal);
        if (found) dependencies.push(found.id);
      }
      if (match[2]) stages.add(match[2].toLowerCase());
    }
    return dependencies;
  }
  async associatePrepared(value: unknown, signal: AbortSignal): Promise<void> {
    if (typeof value === "string" && (managed(value) || digest.test(value))) await this.observe(value, signal);
    else if (Array.isArray(value)) for (const item of value) await this.associatePrepared(item, signal);
    else if (value && typeof value === "object") for (const item of Object.values(value)) await this.associatePrepared(item, signal);
  }

  async cleanup(request: ImageCleanupRequest, signal: AbortSignal): Promise<ImageCleanupNode> {
    if (!request.all && !request.configFingerprint) throw new TypeError("Image cleanup requires a configuration or --all");
    const callerSignal = signal;
    const deadline = AbortSignal.timeout(600_000);
    signal = AbortSignal.any([signal, deadline]);
    const commandSignal = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const command = (args: string[]) => this.raw(args, { signal: commandSignal() });
    const { id } = await this.location(signal);
    return this.edit(signal, async data => {
      const items: ImageCleanupItem[] = [];
      const leases = data.leases.filter(activeLease);
      const inventory = !leases.length || request.all
        ? (await command(["image", "ls", "--all", "--no-trunc", "--format", "{{json .}}"])).stdout.trim() : "";
      const listedImages = new Map<string, string | null>();
      const recordedReferences = new Set(data.entries.map(entry => entry.reference));
      for (const line of inventory.split(/\r?\n/u).filter(Boolean)) {
        const image: unknown = JSON.parse(line);
        if (!image || typeof image !== "object" || !("Repository" in image) || typeof image.Repository !== "string" || !("Tag" in image) || typeof image.Tag !== "string") throw new Error("Invalid Docker image list");
        if (image.Tag === "<none>") continue;
        const reference = `${image.Repository}:${image.Tag}`;
        const listedId = "ID" in image && typeof image.ID === "string" && digest.test(image.ID) ? image.ID : undefined;
        listedImages.set(referenceIdentity(reference), listedId ?? null);
        if (request.all && legacyOwned(reference) && !recordedReferences.has(reference)) {
          const found = listedId ? { id: listedId } : await this.inspect(reference, commandSignal());
          if (found) {
            data.entries.push({ reference, id: found.id, owned: true, owners: [], dependencies: [] });
            recordedReferences.add(reference);
          }
        }
      }
      const inScope = (entry: Entry) => request.all || entry.owners.some(owner => owner.configFingerprint === request.configFingerprint);
      const remainingOwners = (entry: Entry) => entry.owners.filter(owner => owner.configFingerprint !== request.configFingerprint);
      const add = (entry: Entry, status: ImageCleanupItem["status"], reason: string) =>
        items.push({ reference: entry.reference, imageId: entry.id, status, reason });
      // Digest references and bare IDs are not necessarily present in the tag listing.
      const listedTag = (reference: string) => reference.includes("@") || /^(?:sha256:)?[a-f0-9]{12,64}$/u.test(reference)
        ? null : listedImages.get(referenceIdentity(reference));
      const stale = new Set<Entry>();
      const changed = new Set<Entry>();
      if (!leases.length) for (const entry of data.entries) {
        signal.throwIfAborted();
        const listed = listedTag(entry.reference);
        let actual = listed;
        if (listed === null) {
          try { actual = (await this.inspect(entry.reference, commandSignal()))?.id; }
          catch { signal.throwIfAborted(); continue; } // Unverified references still protect their image IDs.
        }
        if (actual === undefined) stale.add(entry);
        else if (actual !== entry.id) changed.add(entry);
      }
      // An absent alias cannot keep a live alias of the same ID in use.
      const selected = data.entries.filter(entry => inScope(entry) && !stale.has(entry));
      if (request.execute) data.entries = data.entries.filter(entry => !stale.has(entry));
      // A lease already forbids every deletion. Do not hold up its release
      // while inspecting containers which cannot change this decision.
      const used = leases.length ? new Set<string>() : await this.containerImages(commandSignal());
      const retainedIds = new Set(data.entries.filter(entry =>
        !request.all && !stale.has(entry) && !changed.has(entry) && remainingOwners(entry).length).map(entry => entry.id));
      // Remove derived images before their inputs. Aliases can have the same ID.
      const ordered: Entry[] = [], pending = [...selected];
      while (pending.length) {
        const index = pending.findIndex(entry => !pending.some(other => other.id !== entry.id && other.dependencies.includes(entry.id)));
        ordered.push(pending.splice(index < 0 ? 0 : index, 1)[0]!);
      }
      for (const entry of ordered) {
        const report = (status: ImageCleanupItem["status"], reason: string) => add(entry, status, reason);
        if (signal.aborted) { report("skipped", "Cleanup cancelled before this reference was processed"); continue; }
        if (leases.length) { report("skipped", "Docker images are in use by evaluation or preparation"); continue; }
        if (changed.has(entry)) { report("skipped", "Image reference changed since it was recorded"); continue; }
        if (!entry.owned) {
          if (request.execute) entry.owners = request.all ? [] : remainingOwners(entry);
          report("retained", "Source reference existed before evaluator acquisition"); continue;
        }
        if (used.has(entry.id)) { report("skipped", "Referenced by a running or stopped container"); continue; }
        if (retainedIds.has(entry.id)) {
          if (request.execute) entry.owners = remainingOwners(entry);
          report("retained", "Still associated with another configuration or task"); continue;
        }
        try {
          const listedId = listedTag(entry.reference);
          const snapshotPreview = !request.execute && typeof listedId === "string";
          // A preview is a snapshot; removing images still rechecks each exact
          // reference immediately before its delete command.
          const current = snapshotPreview ? listedId ? { id: listedId, tags: [] } : undefined
            : await this.inspect(entry.reference, commandSignal());
          if (!current) { if (request.execute) data.entries = data.entries.filter(item => item !== entry); report("skipped", "Reference is already absent"); continue; }
          if (current.id !== entry.id) { report("skipped", "Image reference changed since it was recorded"); continue; }
          if (entry.reference.includes("@") && current.tags.some(reference => !data.entries.some(record => record.reference === reference && record.id === entry.id && record.owned))) {
            report("retained", "Digest also has image tags outside evaluator ownership"); continue;
          }
          if (!request.execute) { report("candidate", "Eligible evaluator image reference"); continue; }
          await command(["image", "rm", "--no-prune", entry.reference]);
          data.entries = data.entries.filter(item => item !== entry);
          report("deleted", "Removed evaluator image reference");
        } catch { report("failed", signal.aborted ? "Cleanup interrupted; removal was not confirmed" : "Docker could not remove or verify the image reference"); }
      }
      if (request.execute) data.leases = leases;
      return { nodeId: hostname(), daemonId: id, inventoryId: data.inventoryId, items,
        ...(deadline.aborted && !callerSignal.aborted ? { error: "Image cleanup deadline exceeded" } : {}) };
    }, request.execute);
  }
}

function validOwner(value: unknown): value is Owner {
  return Boolean(value && typeof value === "object" && "configFingerprint" in value && typeof value.configFingerprint === "string" &&
    "taskId" in value && typeof value.taskId === "string" && "phase" in value && typeof value.phase === "string");
}
