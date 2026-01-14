-- Mock 动态数据
-- 先确保有一个用户来发布这些帖子

-- 获取第一个用户的ID（如果没有用户，这些插入会失败，需要先有用户）
DO $$
DECLARE
  v_user_id UUID;
  v_group_id UUID;
BEGIN
  -- 尝试获取一个已存在的用户
  SELECT id INTO v_user_id FROM auth.users LIMIT 1;
  
  IF v_user_id IS NULL THEN
    RAISE NOTICE '没有找到用户，请先创建用户后再运行此脚本';
    RETURN;
  END IF;

  -- 获取或创建一个小组
  SELECT id INTO v_group_id FROM groups WHERE name = '量化交易研究' LIMIT 1;
  IF v_group_id IS NULL THEN
    INSERT INTO groups (name, description, avatar_url, member_count)
    VALUES ('量化交易研究', '讨论量化交易策略和算法', NULL, 128)
    RETURNING id INTO v_group_id;
  END IF;

  -- 插入 Mock 帖子（如果不存在）
  -- 帖子 1: 高点赞的帖子
  IF NOT EXISTS (SELECT 1 FROM posts WHERE title = 'BTC 突破 10 万美金后的技术分析') THEN
    INSERT INTO posts (
      title, content, author_id, author_handle, group_id,
      like_count, dislike_count, comment_count, view_count, hot_score,
      poll_enabled, poll_bull, poll_bear, poll_wait
    ) VALUES (
      'BTC 突破 10 万美金后的技术分析',
      '大家好，今天来分析一下 BTC 突破 10 万美金后的走势。

从技术面来看，周线级别的上升趋势非常明显，RSI 指标处于强势区域但尚未超买。支撑位在 95000 附近，阻力位在 108000。

关键观察点：
1. 成交量是否能持续放大
2. ETF 资金流入情况
3. 链上数据显示长期持有者增加

我的观点是继续看多，目标位 120000。大家怎么看？',
      v_user_id, 'CryptoTrader', v_group_id,
      156, 12, 45, 2340, 1500,
      true, 89, 23, 15
    );
  END IF;

  -- 帖子 2: 策略分享
  IF NOT EXISTS (SELECT 1 FROM posts WHERE title = '分享一个低风险的网格交易策略') THEN
    INSERT INTO posts (
      title, content, author_id, author_handle, group_id,
      like_count, dislike_count, comment_count, view_count, hot_score,
      poll_enabled
    ) VALUES (
      '分享一个低风险的网格交易策略',
      '最近在用一个改良版的网格交易策略，效果不错，分享给大家。

核心思路：
- 在震荡行情中布局，设置 3-5% 的网格间距
- 使用总资金的 30% 做网格，70% 保留作为补仓资金
- 严格设置止损，单次亏损不超过 2%

过去三个月的回测数据：
- 胜率：73%
- 盈亏比：1.8:1
- 最大回撤：8.5%

有兴趣的可以一起讨论，有问题随时问。',
      v_user_id, 'GridMaster', v_group_id,
      98, 5, 32, 1856, 980,
      false
    );
  END IF;

  -- 帖子 3: 市场讨论
  IF NOT EXISTS (SELECT 1 FROM posts WHERE title = 'ETH 2.0 升级后的质押收益分析') THEN
    INSERT INTO posts (
      title, content, author_id, author_handle, group_id,
      like_count, dislike_count, comment_count, view_count, hot_score,
      poll_enabled, poll_bull, poll_bear, poll_wait
    ) VALUES (
      'ETH 2.0 升级后的质押收益分析',
      'ETH 2.0 升级已经稳定运行了一段时间，来分析一下质押收益：

当前数据：
- 年化收益率：约 4.2%
- 总质押量：超过 3000 万 ETH
- 验证者数量：超过 90 万

对比其他质押方案：
- Lido：3.8% APY
- Rocket Pool：4.0% APY
- CEX 质押：3.5-4.5% APY

个人建议：
长期持有者可以考虑直接质押，但要注意退出周期较长。短期需要流动性的可以选择 Lido 等流动性质押方案。

你们选择哪种方式质押？',
      v_user_id, 'ETHMaxi', v_group_id,
      87, 8, 28, 1432, 870,
      true, 56, 12, 34
    );
  END IF;

  -- 帖子 4: 风险提示
  IF NOT EXISTS (SELECT 1 FROM posts WHERE title = '注意！最近出现的几个高风险项目') THEN
    INSERT INTO posts (
      title, content, author_id, author_handle, group_id,
      like_count, dislike_count, comment_count, view_count, hot_score,
      poll_enabled
    ) VALUES (
      '注意！最近出现的几个高风险项目',
      '最近发现几个疑似 Rug Pull 的项目，提醒大家注意：

危险信号：
1. 团队匿名且无法验证背景
2. 合约未开源或审计
3. 代币分配不透明
4. 社交媒体突然大量推广
5. 承诺不切实际的收益

如何保护自己：
- 小资金试水，不要 All in
- 检查合约是否有后门
- 观察大户地址动向
- 加入社区了解真实情况

记住：如果看起来太好，那可能就是骗局。大家谨慎投资！',
      v_user_id, 'SafetyFirst', v_group_id,
      234, 3, 67, 4521, 2800,
      false
    );
  END IF;

  -- 帖子 5: 交易心得
  IF NOT EXISTS (SELECT 1 FROM posts WHERE title = '从亏损 50% 到稳定盈利的心路历程') THEN
    INSERT INTO posts (
      title, content, author_id, author_handle, group_id,
      like_count, dislike_count, comment_count, view_count, hot_score,
      poll_enabled
    ) VALUES (
      '从亏损 50% 到稳定盈利的心路历程',
      '分享一下我的交易成长历程，希望对新手有帮助。

第一阶段（亏损期）：
- 追涨杀跌，FOMO 严重
- 没有止损概念
- 仓位管理混乱
- 最大亏损达到 50%

第二阶段（学习期）：
- 开始系统学习技术分析
- 建立交易日志
- 每笔交易都写复盘

第三阶段（稳定期）：
- 形成自己的交易系统
- 严格执行纪律
- 月均收益 5-10%
- 最大回撤控制在 15% 以内

核心教训：
交易最重要的是风控和心态，技术分析只是工具。与其寻找圣杯，不如建立适合自己的系统并严格执行。

欢迎交流讨论！',
      v_user_id, 'TradingJourney', v_group_id,
      312, 7, 89, 5678, 3500,
      false
    );
  END IF;

  -- 帖子 6: DeFi 分析
  IF NOT EXISTS (SELECT 1 FROM posts WHERE title = 'Uniswap V4 新功能解读') THEN
    INSERT INTO posts (
      title, content, author_id, author_handle, group_id,
      like_count, dislike_count, comment_count, view_count, hot_score,
      poll_enabled
    ) VALUES (
      'Uniswap V4 新功能解读',
      'Uniswap V4 带来了很多新特性，简单解读一下：

主要更新：
1. Hooks 机制 - 允许开发者自定义 swap 前后的逻辑
2. 单例合约设计 - 所有池子共用一个合约，降低 gas
3. Flash accounting - 进一步优化 gas
4. 原生 ETH 支持 - 不需要先 wrap 成 WETH

对用户的影响：
- 交易手续费可能降低 30-50%
- 更多创新的 AMM 设计会出现
- LP 策略更加灵活

对开发者的影响：
- 更容易构建定制化的 DEX
- 新的 MEV 防护方案成为可能

总体来说是个重大升级，期待正式上线！',
      v_user_id, 'DeFiDev', v_group_id,
      145, 4, 38, 2890, 1450,
      false
    );
  END IF;

  RAISE NOTICE 'Mock 帖子数据已插入/更新';
END $$;

-- 更新热度分数（基于点赞和评论）
UPDATE posts 
SET hot_score = COALESCE(like_count, 0) * 10 + COALESCE(comment_count, 0) * 5 + COALESCE(view_count, 0) * 0.1
WHERE hot_score IS NULL OR hot_score = 0;

SELECT 'Mock 数据创建完成！' as status;

