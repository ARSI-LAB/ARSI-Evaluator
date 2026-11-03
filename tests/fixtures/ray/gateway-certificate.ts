import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createGatewayCertificate(security: string): Promise<void> {
  const config = join(security, "openssl.cnf");
  await writeFile(config, "[req]\ndistinguished_name = dn\n[dn]\n");
  const result = spawnSync("openssl", ["req", "-config", config, "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", join(security, "key.pem"), "-out", join(security, "cert.pem"), "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], { windowsHide: true });
  if (result.status !== 0) throw result.error ?? new Error(result.stderr.toString());
}
