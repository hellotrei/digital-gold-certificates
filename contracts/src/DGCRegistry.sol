// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * DGCRegistry
 * Minimal event-focused contract for ownership timelines.
 *
 * Starter intentionally avoids storing sensitive metadata on-chain.
 * Store proof hashes / IDs only; keep full certificate payload off-chain + signed.
 */
contract DGCRegistry {
    event Issued(bytes32 indexed certId, address indexed owner, uint256 amountGramScaled, uint16 purityBps, bytes32 proofHash);
    event Transferred(bytes32 indexed certId, address indexed from, address indexed to, uint256 amountGramScaled, uint256 priceScaled, bytes32 proofHash);
    event Split(bytes32 indexed parentCertId, bytes32 indexed childCertId, address indexed from, address to, uint256 amountChildGramScaled, bytes32 proofHash);
    event StatusChanged(bytes32 indexed certId, uint8 status); // 0 ACTIVE, 1 LOCKED, 2 REDEEMED, 3 REVOKED

    function issue(bytes32 certId, address owner, uint256 amountGramScaled, uint16 purityBps, bytes32 proofHash) external {
        emit Issued(certId, owner, amountGramScaled, purityBps, proofHash);
    }

    function transfer(bytes32 certId, address from, address to, uint256 amountGramScaled, uint256 priceScaled, bytes32 proofHash) external {
        emit Transferred(certId, from, to, amountGramScaled, priceScaled, proofHash);
    }

    function split(bytes32 parentCertId, bytes32 childCertId, address from, address to, uint256 amountChildGramScaled, bytes32 proofHash) external {
        emit Split(parentCertId, childCertId, from, to, amountChildGramScaled, proofHash);
    }

    function setStatus(bytes32 certId, uint8 status) external {
        require(status <= 3, "bad status");
        emit StatusChanged(certId, status);
    }
}
