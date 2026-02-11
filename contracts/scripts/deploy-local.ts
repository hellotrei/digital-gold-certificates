import hre from "hardhat";

async function main() {
  const factory = await hre.ethers.getContractFactory("DGCRegistry");
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  // Print env-ready output so it can be copied to ledger-adapter config.
  // eslint-disable-next-line no-console
  console.log(`DGC_REGISTRY_ADDRESS=${address}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
