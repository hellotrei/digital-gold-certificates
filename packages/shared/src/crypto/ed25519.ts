import * as ed from "@noble/ed25519";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";

export async function signHex(hashHex: string, privateKeyHex: string): Promise<string> {
  const sig = await ed.signAsync(hexToBytes(hashHex), hexToBytes(privateKeyHex));
  return bytesToHex(sig);
}

export async function verifyHex(hashHex: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  return ed.verifyAsync(hexToBytes(signatureHex), hexToBytes(hashHex), hexToBytes(publicKeyHex));
}
