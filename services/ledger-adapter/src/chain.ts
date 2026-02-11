import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  getAddress,
  id,
  isAddress,
} from "ethers";
import type { LedgerEvent } from "@dgc/shared";

const DGC_REGISTRY_ABI = [
  "function issue(bytes32 certId, address owner, uint256 amountGramScaled, uint16 purityBps, bytes32 proofHash)",
  "function transfer(bytes32 certId, address from, address to, uint256 amountGramScaled, uint256 priceScaled, bytes32 proofHash)",
  "function split(bytes32 parentCertId, bytes32 childCertId, address from, address to, uint256 amountChildGramScaled, bytes32 proofHash)",
  "function setStatus(bytes32 certId, uint8 status)",
] as const;

const AMOUNT_SCALE = 10000n;
const DEFAULT_CHAIN_RPC_URL = "http://127.0.0.1:8545";
const DEFAULT_LOCAL_CHAIN_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export interface ChainRecordResult {
  txHash: string;
}

export interface ChainStatusResult {
  configured: boolean;
  rpcUrl?: string;
  registryAddress?: string;
  latestBlock?: number;
  signerAddress?: string;
  error?: string;
}

function toBytes32(value: string | undefined): string {
  if (!value) return ZeroHash;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return `0x${value}`;
  return id(value);
}

function toAddress(value: string): string {
  if (isAddress(value)) return getAddress(value);
  const hashed = id(value);
  return getAddress(`0x${hashed.slice(-40)}`);
}

function parseAmountScaled(value: string | undefined): bigint {
  if (!value) return 0n;
  const [wholeRaw, fractionRaw = ""] = value.split(".");
  const whole = BigInt(wholeRaw || "0");
  const fraction = BigInt((fractionRaw + "0000").slice(0, 4));
  return whole * AMOUNT_SCALE + fraction;
}

function parsePurityBps(value: string): number {
  const m = /^(\d{3})\.(\d)$/.exec(value);
  if (!m) return 0;
  return Number(m[1]) * 10 + Number(m[2]);
}

function statusToCode(status: string): number {
  if (status === "ACTIVE") return 0;
  if (status === "LOCKED") return 1;
  if (status === "REDEEMED") return 2;
  if (status === "REVOKED") return 3;
  throw new Error(`Unknown status '${status}'`);
}

export interface ChainWriter {
  recordEvent(event: LedgerEvent): Promise<ChainRecordResult>;
  status(): Promise<ChainStatusResult>;
}

export class DgcRegistryChainWriter implements ChainWriter {
  private readonly rpcUrl: string;
  private readonly registryAddress: string;
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly contract: Contract;

  constructor(rpcUrl: string, privateKey: string, registryAddress: string) {
    this.rpcUrl = rpcUrl;
    this.registryAddress = registryAddress;
    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(privateKey, this.provider);
    this.contract = new Contract(registryAddress, DGC_REGISTRY_ABI, this.wallet);
  }

  async recordEvent(event: LedgerEvent): Promise<ChainRecordResult> {
    let tx: { hash: string; wait: () => Promise<{ hash: string } | null> };

    if (event.type === "ISSUED") {
      tx = await this.contract.issue(
        toBytes32(event.certId),
        toAddress(event.owner),
        parseAmountScaled(event.amountGram),
        parsePurityBps(event.purity),
        toBytes32(event.proofHash),
      );
    } else if (event.type === "TRANSFER") {
      tx = await this.contract.transfer(
        toBytes32(event.certId),
        toAddress(event.from),
        toAddress(event.to),
        parseAmountScaled(event.amountGram),
        parseAmountScaled(event.price),
        toBytes32(event.proofHash),
      );
    } else if (event.type === "SPLIT") {
      tx = await this.contract.split(
        toBytes32(event.parentCertId),
        toBytes32(event.childCertId),
        toAddress(event.from),
        toAddress(event.to),
        parseAmountScaled(event.amountChildGram),
        toBytes32(event.proofHash),
      );
    } else {
      tx = await this.contract.setStatus(
        toBytes32(event.certId),
        statusToCode(event.status),
      );
    }

    const receipt = await tx.wait();
    return { txHash: receipt?.hash || tx.hash };
  }

  async status(): Promise<ChainStatusResult> {
    try {
      const blockNumber = await this.provider.getBlockNumber();
      return {
        configured: true,
        rpcUrl: this.rpcUrl,
        registryAddress: this.registryAddress,
        signerAddress: await this.wallet.getAddress(),
        latestBlock: blockNumber,
      };
    } catch (error) {
      return {
        configured: true,
        rpcUrl: this.rpcUrl,
        registryAddress: this.registryAddress,
        signerAddress: await this.wallet.getAddress(),
        error: error instanceof Error ? error.message : "unknown_error",
      };
    }
  }
}

export function buildChainWriterFromEnv(): ChainWriter | null {
  const registryAddress = process.env.DGC_REGISTRY_ADDRESS;
  if (!registryAddress) return null;

  const rpcUrl = process.env.CHAIN_RPC_URL || DEFAULT_CHAIN_RPC_URL;
  const privateKey =
    process.env.CHAIN_PRIVATE_KEY || DEFAULT_LOCAL_CHAIN_PRIVATE_KEY;
  return new DgcRegistryChainWriter(rpcUrl, privateKey, registryAddress);
}
