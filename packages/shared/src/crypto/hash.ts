import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export function sha256Hex(input: string): string {
  const bytes = utf8ToBytes(input);
  return bytesToHex(sha256(bytes));
}
