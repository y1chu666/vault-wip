import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spkiFingerprint } from "../../src/core/transport.js";

/** 一份自签证书。 */
export interface SelfSignedCertificate {
  readonly pem: string;
  readonly key: string;
  readonly spki: string;
}

let cached: SelfSignedCertificate | null = null;

/**
 * 现场生成一份自签证书，同一个测试进程内复用。
 *
 * 仓库里不放证书，测试也不依赖外网：证书只在一处生成，用完即删。
 */
export function selfSignedCertificate(): SelfSignedCertificate {
  if (cached !== null) {
    return cached;
  }

  const directory = mkdtempSync(join(tmpdir(), "vault-wip-tls-"));
  const keyPath = join(directory, "relay.key");
  const certPath = join(directory, "relay.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=relay.example.com",
    ],
    { stdio: "ignore" },
  );

  cached = {
    pem: readFileSync(certPath, "utf8"),
    key: readFileSync(keyPath, "utf8"),
    spki: spkiFingerprint(new X509Certificate(readFileSync(certPath)).raw),
  };
  process.on("exit", () => {
    rmSync(directory, { recursive: true, force: true });
  });
  return cached;
}
