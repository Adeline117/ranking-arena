// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ArenaMembership
 * @notice ERC-721 NFT membership pass for Arena Pro.
 *         Each token has an expiry timestamp. Holding a non-expired token
 *         grants Pro membership on Arena.
 *
 * @dev Deploy on Base L2 for sub-cent gas costs.
 *      Owner is the Arena backend hot-wallet that mints on Stripe webhook.
 */
contract ArenaMembership is ERC721, Ownable {
    uint256 private _nextTokenId;

    /// @notice Mapping from tokenId to expiry timestamp (unix seconds)
    mapping(uint256 => uint256) public expiresAt;

    /// @notice Price in wei for self-mint (0 = only owner can mint)
    uint256 public mintPrice;

    /// @notice Duration in seconds for new mints (default 30 days)
    uint256 public defaultDuration;

    event MembershipMinted(address indexed to, uint256 indexed tokenId, uint256 expiresAt);
    event MembershipRenewed(uint256 indexed tokenId, uint256 newExpiresAt);
    event MembershipRevoked(uint256 indexed tokenId);

    constructor(
        address initialOwner,
        uint256 _defaultDuration
    ) ERC721("Arena Pro", "ARENAPRO") Ownable(initialOwner) {
        defaultDuration = _defaultDuration > 0 ? _defaultDuration : 30 days;
    }

    // ── Owner-only minting (called by backend after Stripe payment) ──

    /**
     * @notice Mint a membership NFT to `to` with custom duration.
     * @param to Recipient address
     * @param duration Duration in seconds (0 = use defaultDuration)
     */
    function mint(address to, uint256 duration) external onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        uint256 dur = duration > 0 ? duration : defaultDuration;
        expiresAt[tokenId] = block.timestamp + dur;

        _safeMint(to, tokenId);
        emit MembershipMinted(to, tokenId, expiresAt[tokenId]);
        return tokenId;
    }

    /**
     * @notice Extend an existing membership's expiry.
     * @param tokenId Token to renew
     * @param additionalTime Seconds to add (0 = add defaultDuration)
     */
    function renew(uint256 tokenId, uint256 additionalTime) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        uint256 extra = additionalTime > 0 ? additionalTime : defaultDuration;
        uint256 base = expiresAt[tokenId] > block.timestamp ? expiresAt[tokenId] : block.timestamp;
        expiresAt[tokenId] = base + extra;
        emit MembershipRenewed(tokenId, expiresAt[tokenId]);
    }

    /**
     * @notice Revoke a membership (set expiry to now).
     */
    function revoke(uint256 tokenId) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        expiresAt[tokenId] = block.timestamp;
        emit MembershipRevoked(tokenId);
    }

    // ── Public self-mint (optional, when mintPrice > 0) ──

    function selfMint() external payable returns (uint256) {
        require(mintPrice > 0, "Self-mint disabled");
        require(msg.value >= mintPrice, "Insufficient payment");

        uint256 tokenId = _nextTokenId++;
        expiresAt[tokenId] = block.timestamp + defaultDuration;
        _safeMint(msg.sender, tokenId);
        emit MembershipMinted(msg.sender, tokenId, expiresAt[tokenId]);
        return tokenId;
    }

    // ── View functions ──

    /**
     * @notice Check if an address holds a valid (non-expired) membership.
     */
    function hasValidMembership(address user) external view returns (bool) {
        uint256 balance = balanceOf(user);
        if (balance == 0) return false;

        // Check all tokens owned by user (linear scan — fine for small balances)
        for (uint256 i = 0; i < _nextTokenId; i++) {
            if (_ownerOf(i) == user && expiresAt[i] > block.timestamp) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Check if a specific token is still valid.
     */
    function isValid(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0) && expiresAt[tokenId] > block.timestamp;
    }

    // ── Admin setters ──

    function setMintPrice(uint256 price) external onlyOwner {
        mintPrice = price;
    }

    function setDefaultDuration(uint256 duration) external onlyOwner {
        require(duration > 0, "Duration must be positive");
        defaultDuration = duration;
    }

    function withdraw() external onlyOwner {
        (bool ok, ) = owner().call{value: address(this).balance}("");
        require(ok, "Withdraw failed");
    }
}
