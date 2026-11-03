/** Bootstrap CA trust using signed APT packages before selecting an HTTPS mirror. */
export function aptMirrorInstructions(mirror: URL): string[] {
  // Fill only unset options. Existing image configuration and later task
  // settings, including apt-get -o arguments, keep their explicit values.
  const defaults = [
    ["Acquire::Retries", "3"],
    ["Acquire::http::Timeout", "30"],
    ["Acquire::https::Timeout", "30"],
    ["APT::Update::Error-Mode", "any"],
  ].map(([key, value]) =>
    `configured=$(apt-config shell evaluator_value ${key}) || exit $?; if [ -z "$configured" ]; then printf '%s\\n' '${key} "${value}";' >> /etc/apt/apt.conf.d/00-evaluator-network-defaults; fi`).join("; ");
  const downloads = `RUN if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then mkdir -p /etc/apt/apt.conf.d; ${defaults}; fi`;
  const rewrite = (origin: string, previous?: string) => {
    const alias = previous?.replaceAll(".", "\\.").replaceAll("[", "\\[").replaceAll("]", "\\]");
    const repositories: [string, string][] = [
      ["https\\?://deb\\.debian\\.org/debian-security", "debian-security"],
      ["https\\?://security\\.debian\\.org/debian-security", "debian-security"],
      ["https\\?://deb\\.debian\\.org/debian", "debian"],
      ["https\\?://archive\\.ubuntu\\.com/ubuntu", "ubuntu"],
      ["https\\?://[[:alnum:].-]*\\.archive\\.ubuntu\\.com/ubuntu", "ubuntu"],
      ["https\\?://security\\.ubuntu\\.com/ubuntu", "ubuntu"],
      ["https\\?://ports\\.ubuntu\\.com/ubuntu-ports", "ubuntu-ports"],
    ];
    // Match complete repository paths; do not rewrite third-party repositories
    // or similarly named paths such as /ubuntu-extra.
    const replacements = repositories.map(([source, target]) =>
      `-e 's#${source}\\([/[:space:]]\\|$\\)#${origin}/${target}\\1#g'`);
    if (alias) replacements.push(`-e 's#${alias}/#${origin}/#g'`);
    return `if [ "$(id -u)" = 0 ]; then for list in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do if [ -f "$list" ]; then sed -i ${replacements.join(" ")} "$list"; fi; done; fi`;
  };
  if (mirror.protocol !== "https:") return [downloads, `RUN ${rewrite(mirror.origin)}`];
  const bootstrap = new URL(mirror.origin);
  bootstrap.protocol = "http:";
  return [
    downloads,
    `RUN if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then ${rewrite(bootstrap.origin, mirror.origin)}; apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*; fi`,
    `RUN ${rewrite(mirror.origin, bootstrap.origin)}`,
  ];
}
