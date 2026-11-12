export type KernelRequest = Record<string, unknown> & { candidateRoot: string; hashes: Record<string, string> };

export function lockedCandidateFiles({ candidateRoot, hashes }: KernelRequest) {
  const prefix = `${candidateRoot}/`;
  return Object.keys(hashes).filter(path => path.startsWith(prefix)).sort()
    .map(path => ({ path: path.slice(prefix.length), sha256: hashes[path]! }));
}
