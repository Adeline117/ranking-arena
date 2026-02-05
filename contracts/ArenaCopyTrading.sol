// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ArenaCopyTrading
 * @notice On-chain copy trading contract for Arena platform.
 *         Allows users to subscribe to trader strategies with customizable parameters.
 *
 * @dev Deploy on Base L2 for low gas costs.
 *      This contract manages subscriptions and parameters only - actual trade execution
 *      is handled off-chain by the Arena backend based on subscription data.
 *
 * Key features:
 * - Subscribe to any trader with custom allocation
 * - Set stop-loss and max leverage limits
 * - Pause/resume subscriptions
 * - Emergency exit with immediate position closure
 */
contract ArenaCopyTrading is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Types ──

    enum StrategyStatus {
        Active,
        Paused,
        Stopped,
        Liquidated
    }

    struct Strategy {
        address trader;           // Trader being copied
        address follower;         // Subscriber address
        uint256 allocation;       // Amount allocated (in collateral token)
        uint256 maxPositionSize;  // Max size per position
        uint8 stopLossPercent;    // Stop loss threshold (0-100)
        uint8 leverage;           // Max leverage allowed
        StrategyStatus status;    // Current status
        int256 totalPnl;          // Total realized PnL
        uint256 createdAt;        // Subscription timestamp
        uint256 updatedAt;        // Last update timestamp
    }

    struct Position {
        bytes32 symbol;           // Trading pair (e.g., "BTC-USD")
        uint8 side;               // 0 = long, 1 = short
        uint256 size;             // Position size
        uint256 entryPrice;       // Entry price (scaled by 1e6)
        uint8 leverage;           // Position leverage
        uint256 openedAt;         // Position open timestamp
    }

    // ── State ──

    /// @notice Collateral token (e.g., USDC)
    IERC20 public immutable collateralToken;

    /// @notice Platform fee in basis points (e.g., 100 = 1%)
    uint256 public platformFeeBps;

    /// @notice Trader profit share in basis points (e.g., 1000 = 10%)
    uint256 public traderShareBps;

    /// @notice Minimum allocation amount
    uint256 public minAllocation;

    /// @notice Maximum followers per trader
    uint256 public maxFollowersPerTrader;

    /// @notice Strategy ID counter
    uint256 private _nextStrategyId;

    /// @notice Strategy ID => Strategy data
    mapping(bytes32 => Strategy) public strategies;

    /// @notice Strategy ID => Positions array
    mapping(bytes32 => Position[]) public positions;

    /// @notice Trader => follower count
    mapping(address => uint256) public traderFollowerCount;

    /// @notice User => active strategy IDs
    mapping(address => bytes32[]) public userStrategies;

    /// @notice Authorized executors (Arena backend)
    mapping(address => bool) public executors;

    // ── Events ──

    event StrategyCreated(
        bytes32 indexed strategyId,
        address indexed trader,
        address indexed follower,
        uint256 allocation
    );

    event StrategyUpdated(
        bytes32 indexed strategyId,
        uint256 maxPositionSize,
        uint8 stopLossPercent,
        uint8 leverage
    );

    event StrategyPaused(bytes32 indexed strategyId);
    event StrategyResumed(bytes32 indexed strategyId);
    event StrategyUnsubscribed(bytes32 indexed strategyId, int256 finalPnl);
    event EmergencyExit(bytes32 indexed strategyId);

    event PositionOpened(
        bytes32 indexed strategyId,
        bytes32 symbol,
        uint8 side,
        uint256 size,
        uint256 entryPrice
    );

    event PositionClosed(
        bytes32 indexed strategyId,
        bytes32 symbol,
        int256 pnl
    );

    event PnlUpdated(bytes32 indexed strategyId, int256 newTotalPnl);

    // ── Modifiers ──

    modifier onlyExecutor() {
        require(executors[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    modifier strategyExists(bytes32 strategyId) {
        require(strategies[strategyId].follower != address(0), "Strategy not found");
        _;
    }

    modifier onlyFollower(bytes32 strategyId) {
        require(strategies[strategyId].follower == msg.sender, "Not strategy owner");
        _;
    }

    // ── Constructor ──

    constructor(
        address _collateralToken,
        address _initialOwner,
        uint256 _minAllocation,
        uint256 _platformFeeBps,
        uint256 _traderShareBps,
        uint256 _maxFollowersPerTrader
    ) Ownable(_initialOwner) {
        require(_collateralToken != address(0), "Invalid collateral token");
        require(_platformFeeBps <= 500, "Platform fee too high"); // Max 5%
        require(_traderShareBps <= 3000, "Trader share too high"); // Max 30%

        collateralToken = IERC20(_collateralToken);
        minAllocation = _minAllocation;
        platformFeeBps = _platformFeeBps;
        traderShareBps = _traderShareBps;
        maxFollowersPerTrader = _maxFollowersPerTrader;
    }

    // ── User Functions ──

    /**
     * @notice Subscribe to copy a trader's strategies.
     * @param trader Address of the trader to copy
     * @param allocation Amount to allocate (transferred from caller)
     * @param maxPositionSize Maximum size per position
     * @param stopLossPercent Stop loss threshold (0-100)
     * @param leverage Maximum leverage (1-100)
     * @return strategyId Unique identifier for the subscription
     */
    function subscribe(
        address trader,
        uint256 allocation,
        uint256 maxPositionSize,
        uint8 stopLossPercent,
        uint8 leverage
    ) external nonReentrant returns (bytes32 strategyId) {
        require(trader != address(0), "Invalid trader");
        require(trader != msg.sender, "Cannot copy yourself");
        require(allocation >= minAllocation, "Below minimum allocation");
        require(stopLossPercent <= 100, "Invalid stop loss");
        require(leverage >= 1 && leverage <= 100, "Invalid leverage");
        require(
            traderFollowerCount[trader] < maxFollowersPerTrader,
            "Trader at max capacity"
        );

        // Transfer collateral
        collateralToken.safeTransferFrom(msg.sender, address(this), allocation);

        // Generate strategy ID
        strategyId = keccak256(
            abi.encodePacked(msg.sender, trader, block.timestamp, _nextStrategyId++)
        );

        // Create strategy
        strategies[strategyId] = Strategy({
            trader: trader,
            follower: msg.sender,
            allocation: allocation,
            maxPositionSize: maxPositionSize,
            stopLossPercent: stopLossPercent,
            leverage: leverage,
            status: StrategyStatus.Active,
            totalPnl: 0,
            createdAt: block.timestamp,
            updatedAt: block.timestamp
        });

        // Update tracking
        traderFollowerCount[trader]++;
        userStrategies[msg.sender].push(strategyId);

        emit StrategyCreated(strategyId, trader, msg.sender, allocation);
    }

    /**
     * @notice Unsubscribe from a strategy and withdraw remaining funds.
     * @param strategyId Strategy to unsubscribe from
     */
    function unsubscribe(bytes32 strategyId)
        external
        nonReentrant
        strategyExists(strategyId)
        onlyFollower(strategyId)
    {
        Strategy storage strategy = strategies[strategyId];
        require(
            strategy.status != StrategyStatus.Stopped,
            "Already unsubscribed"
        );

        // Calculate final amount after PnL and fees
        int256 finalAmount = int256(strategy.allocation) + strategy.totalPnl;
        uint256 withdrawAmount = finalAmount > 0 ? uint256(finalAmount) : 0;

        // Deduct fees if profitable
        if (strategy.totalPnl > 0) {
            uint256 profit = uint256(strategy.totalPnl);
            uint256 platformFee = (profit * platformFeeBps) / 10000;
            uint256 traderShare = (profit * traderShareBps) / 10000;
            withdrawAmount = withdrawAmount - platformFee - traderShare;

            // Transfer trader share
            if (traderShare > 0) {
                collateralToken.safeTransfer(strategy.trader, traderShare);
            }
        }

        // Update state
        strategy.status = StrategyStatus.Stopped;
        strategy.updatedAt = block.timestamp;
        traderFollowerCount[strategy.trader]--;

        // Transfer remaining funds to follower
        if (withdrawAmount > 0) {
            collateralToken.safeTransfer(msg.sender, withdrawAmount);
        }

        emit StrategyUnsubscribed(strategyId, strategy.totalPnl);
    }

    /**
     * @notice Pause a strategy (stop opening new positions).
     */
    function pause(bytes32 strategyId)
        external
        strategyExists(strategyId)
        onlyFollower(strategyId)
    {
        Strategy storage strategy = strategies[strategyId];
        require(strategy.status == StrategyStatus.Active, "Not active");

        strategy.status = StrategyStatus.Paused;
        strategy.updatedAt = block.timestamp;

        emit StrategyPaused(strategyId);
    }

    /**
     * @notice Resume a paused strategy.
     */
    function resume(bytes32 strategyId)
        external
        strategyExists(strategyId)
        onlyFollower(strategyId)
    {
        Strategy storage strategy = strategies[strategyId];
        require(strategy.status == StrategyStatus.Paused, "Not paused");

        strategy.status = StrategyStatus.Active;
        strategy.updatedAt = block.timestamp;

        emit StrategyResumed(strategyId);
    }

    /**
     * @notice Emergency exit - close all positions immediately.
     */
    function emergencyExit(bytes32 strategyId)
        external
        strategyExists(strategyId)
        onlyFollower(strategyId)
    {
        Strategy storage strategy = strategies[strategyId];
        require(
            strategy.status == StrategyStatus.Active ||
            strategy.status == StrategyStatus.Paused,
            "Cannot exit"
        );

        // Mark for emergency exit - backend will close positions
        strategy.status = StrategyStatus.Stopped;
        strategy.updatedAt = block.timestamp;

        emit EmergencyExit(strategyId);
    }

    /**
     * @notice Update strategy settings.
     */
    function updateSettings(
        bytes32 strategyId,
        uint256 maxPositionSize,
        uint8 stopLossPercent,
        uint8 leverage
    )
        external
        strategyExists(strategyId)
        onlyFollower(strategyId)
    {
        require(stopLossPercent <= 100, "Invalid stop loss");
        require(leverage >= 1 && leverage <= 100, "Invalid leverage");

        Strategy storage strategy = strategies[strategyId];
        strategy.maxPositionSize = maxPositionSize;
        strategy.stopLossPercent = stopLossPercent;
        strategy.leverage = leverage;
        strategy.updatedAt = block.timestamp;

        emit StrategyUpdated(strategyId, maxPositionSize, stopLossPercent, leverage);
    }

    // ── Executor Functions (Backend) ──

    /**
     * @notice Record a position opened by the backend.
     */
    function recordPositionOpen(
        bytes32 strategyId,
        bytes32 symbol,
        uint8 side,
        uint256 size,
        uint256 entryPrice,
        uint8 leverage
    ) external onlyExecutor strategyExists(strategyId) {
        positions[strategyId].push(Position({
            symbol: symbol,
            side: side,
            size: size,
            entryPrice: entryPrice,
            leverage: leverage,
            openedAt: block.timestamp
        }));

        emit PositionOpened(strategyId, symbol, side, size, entryPrice);
    }

    /**
     * @notice Record a position closed and update PnL.
     */
    function recordPositionClose(
        bytes32 strategyId,
        uint256 positionIndex,
        int256 pnl
    ) external onlyExecutor strategyExists(strategyId) {
        require(positionIndex < positions[strategyId].length, "Invalid position");

        Position storage pos = positions[strategyId][positionIndex];
        bytes32 symbol = pos.symbol;

        // Remove position (swap with last and pop)
        uint256 lastIndex = positions[strategyId].length - 1;
        if (positionIndex != lastIndex) {
            positions[strategyId][positionIndex] = positions[strategyId][lastIndex];
        }
        positions[strategyId].pop();

        // Update PnL
        strategies[strategyId].totalPnl += pnl;
        strategies[strategyId].updatedAt = block.timestamp;

        emit PositionClosed(strategyId, symbol, pnl);
        emit PnlUpdated(strategyId, strategies[strategyId].totalPnl);
    }

    /**
     * @notice Update strategy PnL (for unrealized PnL sync).
     */
    function updatePnl(bytes32 strategyId, int256 newTotalPnl)
        external
        onlyExecutor
        strategyExists(strategyId)
    {
        strategies[strategyId].totalPnl = newTotalPnl;
        strategies[strategyId].updatedAt = block.timestamp;

        emit PnlUpdated(strategyId, newTotalPnl);
    }

    /**
     * @notice Mark strategy as liquidated.
     */
    function markLiquidated(bytes32 strategyId)
        external
        onlyExecutor
        strategyExists(strategyId)
    {
        strategies[strategyId].status = StrategyStatus.Liquidated;
        strategies[strategyId].updatedAt = block.timestamp;
    }

    // ── View Functions ──

    /**
     * @notice Get strategy details.
     */
    function getStrategy(bytes32 strategyId)
        external
        view
        returns (Strategy memory)
    {
        return strategies[strategyId];
    }

    /**
     * @notice Get all positions for a strategy.
     */
    function getPositions(bytes32 strategyId)
        external
        view
        returns (Position[] memory)
    {
        return positions[strategyId];
    }

    /**
     * @notice Get user's active strategy IDs.
     */
    function getUserStrategies(address user)
        external
        view
        returns (bytes32[] memory)
    {
        return userStrategies[user];
    }

    /**
     * @notice Check if a strategy is active.
     */
    function isStrategyActive(bytes32 strategyId)
        external
        view
        returns (bool)
    {
        return strategies[strategyId].status == StrategyStatus.Active;
    }

    // ── Admin Functions ──

    function setExecutor(address executor, bool authorized) external onlyOwner {
        executors[executor] = authorized;
    }

    function setMinAllocation(uint256 _minAllocation) external onlyOwner {
        minAllocation = _minAllocation;
    }

    function setPlatformFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 500, "Fee too high");
        platformFeeBps = _feeBps;
    }

    function setTraderShareBps(uint256 _shareBps) external onlyOwner {
        require(_shareBps <= 3000, "Share too high");
        traderShareBps = _shareBps;
    }

    function setMaxFollowersPerTrader(uint256 _max) external onlyOwner {
        maxFollowersPerTrader = _max;
    }

    /**
     * @notice Withdraw platform fees.
     */
    function withdrawFees(address to, uint256 amount) external onlyOwner {
        collateralToken.safeTransfer(to, amount);
    }
}
