import { webcrypto } from "node:crypto";

const pair = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const privateJwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
process.stdout.write(`${JSON.stringify({ VAPID_PRIVATE_KEY: JSON.stringify(privateJwk) }, null, 2)}\n`);
