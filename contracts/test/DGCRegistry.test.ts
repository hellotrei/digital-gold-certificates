import { expect } from "chai";
import { ethers } from "hardhat";

describe("DGCRegistry", function () {
  it("emits Issued", async () => {
    const [owner] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DGCRegistry");
    const c = await F.deploy();

    const certId = ethers.keccak256(ethers.toUtf8Bytes("cert-1"));
    const proofHash = ethers.keccak256(ethers.toUtf8Bytes("proof-1"));

    await expect(c.issue(certId, owner.address, 1000n, 9999, proofHash))
      .to.emit(c, "Issued");
  });
});
