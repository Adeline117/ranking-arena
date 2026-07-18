/** A user-facing string localized into the four site languages. */
export type Localized = { en: string; zh: string; ja: string; ko: string }

export interface Article {
  slug: string
  title: Localized
  excerpt: Localized
  /**
   * Article body (markdown), localized into all four site languages (en/zh/ja/ko).
   * The list card + detail header (title/excerpt) are localized below, and the
   * long-form body is now localized too — consumers pick the current language
   * via pickLocalized(article.content, lang). Preserve markdown structure and
   * keep code/numbers/formulas identical across languages when editing.
   */
  content: Localized
}

/** Pick the current language's value, falling back to English. */
export function pickLocalized(field: Localized, lang: string): string {
  return field[lang as keyof Localized] || field.en
}

export const ARTICLES: Article[] = [
  {
    slug: 'how-arena-score-works',
    title: {
      en: 'How Arena Score Works',
      zh: 'Arena 评分如何运作',
      ja: 'Arena スコアの仕組み',
      ko: 'Arena 점수의 작동 방식',
    },
    excerpt: {
      en: 'Understand the formula behind Arena Score v4 — a single 0-100 rating combining profit, risk, and statistical confidence.',
      zh: '了解 Arena Score v4 背后的公式——将盈利、风险与统计置信度整合为单一的 0-100 分评级。',
      ja: '利益、リスク、統計的信頼度を単一の 0〜100 の評価に統合する Arena Score v4 の計算式を理解しましょう。',
      ko: '수익, 리스크, 통계적 신뢰도를 하나의 0-100점 등급으로 결합하는 Arena Score v4 공식을 이해해 보세요.',
    },
    content: {
      en: `
# How Arena Score Works

Arena Score is a single **0-100 rating** that answers one question: how good is this trader, really? The current version — **Arena Score v4** — rewards genuine profit while staying honest about risk and statistical confidence.

## The Formula

\`Arena Score = 100 × Quality × Confidence\`

**Quality** blends five performance dimensions. **Confidence** scales the score down when there is not enough data to trust it. The result is mapped to a percentile — roughly **the percentage of traders you beat**.

## Quality: Five Dimensions

Quality is split evenly between **earnings (50%)** and **skill (50%)**:

- **PnL — weight 0.30**: absolute profit in USD, on a log-magnitude scale
- **ROI — weight 0.20**: return on investment
- **Drawdown — weight 0.20**: worst peak-to-trough loss (smaller is better)
- **Sharpe — weight 0.20**: risk-adjusted return
- **Consistency — weight 0.10**: win rate and profit factor

Earnings (PnL 0.30 + ROI 0.20 = **0.50**) reward traders who actually make money. Skill (Drawdown 0.20 + Sharpe 0.20 + Consistency 0.10 = **0.50**) rewards doing it with controlled risk. Only the dimensions a trader actually has data for are included, then re-normalized.

## PnL Uses Log-Magnitude

Absolute profit spans a huge range, so PnL is scored logarithmically: roughly **$1K maps to 0 and $10M maps to 1**. A $200 account scores near zero no matter how high its percentage return — real capital is what counts.

## Other Dimensions Are Percentile Ranks

ROI, drawdown, Sharpe, and consistency are scored as **within-cohort percentile ranks**, not fixed thresholds. Each trader is compared against everyone else in the same period, so the scale self-calibrates — a "good" Sharpe is defined by the field, not a hard-coded constant.

## Confidence: Statistical Honesty

\`Confidence = between 0.35 and 1.0\`

Confidence scales with two things:
- **Sample size**: more closed trades means more trust — \`trades / (trades + 50)\`, so 50 trades gives about 0.5
- **Data completeness**: how many risk metrics (Sharpe, drawdown, win rate, profit factor) are actually available

A trader with only 3 trades, or with missing risk data, is structurally capped and cannot reach the top no matter how lucky. Confidence never drops below 0.35, so real traders are never zeroed out.

## The Displayed Score

The composite (Quality × Confidence) is turned into a **percentile**: your score is approximately the percentage of traders you beat. It is blended 70/30 with the relative composite so the very best traders do not all pile up against 100.

## Why It Resists Gaming

- **ROI is compressed** — a 300% return and a 10,000% return land close together, so you cannot farm the top with a tiny account
- **PnL rewards real money** — small accounts score near zero
- **Confidence caps thin track records** — a handful of trades cannot buy a top rank

This keeps the leaderboard honest: consistent, well-capitalized, risk-aware traders rise to the top.
    `.trim(),
      zh: `
# Arena 评分如何运作

Arena 评分是一个单一的 **0-100 分评级**，回答一个问题：这位交易员到底有多强？当前版本 **Arena Score v4** 在奖励真实盈利的同时，对风险和统计置信度保持诚实。

## 计算公式

\`Arena 评分 = 100 × 质量 × 置信度\`

**质量（Quality）** 融合五个表现维度。**置信度（Confidence）** 在数据不足以信任时下调分数。最终结果被映射为一个百分位——大致就是**你超过了多少比例的交易员**。

## 质量：五个维度

质量在**盈利（50%）**和**实力（50%）**之间平均分配：

- **PnL —— 权重 0.30**：以美元计的绝对盈利，采用对数量级
- **ROI —— 权重 0.20**：投资回报率
- **回撤 —— 权重 0.20**：最大峰谷亏损（越小越好）
- **夏普 —— 权重 0.20**：风险调整后收益
- **一致性 —— 权重 0.10**：胜率与盈利因子

盈利（PnL 0.30 + ROI 0.20 = **0.50**）奖励真正赚到钱的交易员。实力（回撤 0.20 + 夏普 0.20 + 一致性 0.10 = **0.50**）奖励在控制风险的前提下做到这一点。只有交易员实际拥有数据的维度才会被纳入，然后重新归一化。

## PnL 采用对数量级

绝对盈利跨度极大，因此 PnL 按对数计分：大致 **$1K 对应 0，$10M 对应 1**。一个 $200 的账户无论百分比收益多高都接近 0 分——真金白银才算数。

## 其余维度是百分位排名

ROI、回撤、夏普和一致性以**队内百分位排名**计分，而非固定阈值。每位交易员都与同一时间段内的其他所有人比较，因此刻度会自我校准——「好」的夏普由整个群体定义，而非写死的常数。

## 置信度：统计上的诚实

\`置信度 = 介于 0.35 与 1.0 之间\`

置信度随两项因素变化：
- **样本量**：已平仓交易越多越可信——\`交易数 / (交易数 + 50)\`，即 50 笔约为 0.5
- **数据完整度**：实际可得的风险指标（夏普、回撤、胜率、盈利因子）有多少

只有 3 笔交易、或缺失风险数据的交易员会被结构性封顶，无论多幸运都进不了顶部。置信度永不低于 0.35，因此真实交易员绝不会被归零。

## 显示分数

综合分（质量 × 置信度）会被转换为**百分位**：你的分数大致就是你超过的交易员比例。它以 70/30 与相对综合分混合，让最顶尖的交易员不至于全部挤在 100 分。

## 为什么它能抗操纵

- **ROI 被压缩** —— 300% 与 10000% 的收益几乎并列，因此你无法用小账户刷上顶部
- **PnL 奖励真金白银** —— 小账户得分接近 0
- **置信度封顶单薄的战绩** —— 寥寥几笔交易买不到顶部排名

这让排行榜保持诚实：稳定、资金充足、有风险意识的交易员才会升到顶部。
    `.trim(),
      ja: `
# Arena スコアの仕組み

Arena スコアは単一の **0〜100 の評価** で、「このトレーダーは本当にどれだけ優秀なのか？」という 1 つの問いに答えます。現行バージョン **Arena Score v4** は、真の利益を評価しつつ、リスクと統計的な信頼度について誠実であり続けます。

## 計算式

\`Arena スコア = 100 × Quality × Confidence\`

**Quality（品質）** は 5 つのパフォーマンス指標を統合します。**Confidence（信頼度）** は信頼に足るデータが不足しているときにスコアを引き下げます。結果はパーセンタイルに変換され、おおよそ**あなたが上回ったトレーダーの割合**を表します。

## Quality：5 つの指標

Quality は **収益（50%）** と **実力（50%）** に均等に分けられます：

- **PnL —— 重み 0.30**：USD 建ての絶対利益（対数スケール）
- **ROI —— 重み 0.20**：投資収益率
- **ドローダウン —— 重み 0.20**：最大の山から谷への下落（小さいほど良い）
- **シャープ —— 重み 0.20**：リスク調整後リターン
- **一貫性 —— 重み 0.10**：勝率と損益比（プロフィットファクター）

収益（PnL 0.30 + ROI 0.20 = **0.50**）は実際に利益を出すトレーダーを評価します。実力（ドローダウン 0.20 + シャープ 0.20 + 一貫性 0.10 = **0.50**）はそれをリスク管理のもとで達成することを評価します。トレーダーが実際にデータを持つ指標のみが対象となり、その後で再正規化されます。

## PnL は対数スケール

絶対利益は非常に幅広いため、PnL は対数で採点されます：おおよそ **$1K が 0、$10M が 1** に対応します。$200 の口座は、パーセンテージのリターンがどれほど高くても 0 点に近くなります——本物の資金こそが重要です。

## その他の指標はパーセンタイル順位

ROI、ドローダウン、シャープ、一貫性は固定しきい値ではなく**同一集団内のパーセンタイル順位**で採点されます。各トレーダーは同じ期間の他の全員と比較されるため、スケールは自己校正されます——「良い」シャープは固定の定数ではなく、母集団によって定義されます。

## Confidence：統計的な誠実さ

\`Confidence = 0.35 から 1.0 の間\`

信頼度は 2 つの要素に応じて変化します：
- **サンプル数**：決済済みの取引が多いほど信頼できます——\`取引数 / (取引数 + 50)\`、つまり 50 取引で約 0.5
- **データの完全性**：リスク指標（シャープ、ドローダウン、勝率、損益比）が実際にどれだけ揃っているか

取引がわずか 3 件、あるいはリスクデータが欠けているトレーダーは構造的に上限が設けられ、どれほど幸運でも上位には到達できません。信頼度は 0.35 を下回ることはなく、実在のトレーダーがゼロになることはありません。

## 表示されるスコア

複合値（Quality × Confidence）は**パーセンタイル**に変換されます：あなたのスコアはおおよそ、あなたが上回ったトレーダーの割合です。相対的な複合値と 70/30 でブレンドされ、最上位のトレーダーが全員 100 に張り付かないようにしています。

## なぜ操作に強いのか

- **ROI は圧縮される** —— 300% と 10,000% のリターンはほぼ並ぶため、小さな口座で上位を稼ぐことはできません
- **PnL は本物の資金を評価する** —— 小口座はほぼ 0 点
- **信頼度が薄い実績に上限をかける** —— わずかな取引で上位ランクは買えません

これによりリーダーボードは誠実に保たれます：一貫性があり、十分な資金を持ち、リスクを意識したトレーダーが上位に上がります。
    `.trim(),
      ko: `
# Arena 점수의 작동 방식

Arena 점수는 "이 트레이더는 실제로 얼마나 뛰어난가?"라는 하나의 질문에 답하는 단일 **0-100점 등급**입니다. 현재 버전인 **Arena Score v4**는 실제 수익을 보상하면서도 리스크와 통계적 신뢰도에 대해 정직함을 유지합니다.

## 공식

\`Arena 점수 = 100 × Quality × Confidence\`

**Quality(품질)** 는 다섯 가지 성과 차원을 결합합니다. **Confidence(신뢰도)** 는 신뢰하기에 데이터가 부족할 때 점수를 낮춥니다. 그 결과는 백분위로 변환되며, 대략 **당신이 이긴 트레이더의 비율**을 나타냅니다.

## Quality: 다섯 가지 차원

Quality는 **수익(50%)** 과 **실력(50%)** 으로 균등하게 나뉩니다:

- **PnL — 가중치 0.30**: USD 기준 절대 수익(로그 규모)
- **ROI — 가중치 0.20**: 투자 수익률
- **드로다운 — 가중치 0.20**: 최고점 대비 최대 하락폭(작을수록 좋음)
- **샤프 — 가중치 0.20**: 리스크 조정 수익
- **일관성 — 가중치 0.10**: 승률과 손익비

수익(PnL 0.30 + ROI 0.20 = **0.50**)은 실제로 돈을 버는 트레이더를 보상합니다. 실력(드로다운 0.20 + 샤프 0.20 + 일관성 0.10 = **0.50**)은 리스크를 통제하며 그것을 해내는 것을 보상합니다. 트레이더가 실제로 데이터를 가진 차원만 포함된 뒤 다시 정규화됩니다.

## PnL은 로그 규모를 사용합니다

절대 수익은 범위가 매우 넓기 때문에 PnL은 로그로 채점됩니다: 대략 **$1K는 0, $10M은 1** 에 대응합니다. $200 계좌는 백분율 수익이 아무리 높아도 0점에 가깝습니다——진짜 자본이 중요합니다.

## 나머지 차원은 백분위 순위입니다

ROI, 드로다운, 샤프, 일관성은 고정 임계값이 아니라 **동일 집단 내 백분위 순위**로 채점됩니다. 각 트레이더는 같은 기간의 다른 모든 사람과 비교되므로 척도가 스스로 보정됩니다——「좋은」 샤프는 하드코딩된 상수가 아니라 집단이 정의합니다.

## Confidence: 통계적 정직함

\`Confidence = 0.35에서 1.0 사이\`

신뢰도는 두 가지 요소에 따라 조정됩니다:
- **표본 크기**: 청산된 거래가 많을수록 더 신뢰됩니다——\`거래 수 / (거래 수 + 50)\`, 즉 50 거래는 약 0.5
- **데이터 완전성**: 리스크 지표(샤프, 드로다운, 승률, 손익비)가 실제로 얼마나 갖춰졌는지

거래가 3건뿐이거나 리스크 데이터가 없는 트레이더는 구조적으로 상한이 걸려, 아무리 운이 좋아도 상위에 도달할 수 없습니다. 신뢰도는 0.35 아래로 내려가지 않으므로 실제 트레이더가 0이 되는 일은 없습니다.

## 표시되는 점수

복합값(Quality × Confidence)은 **백분위**로 변환됩니다: 당신의 점수는 대략 당신이 이긴 트레이더의 비율입니다. 상대 복합값과 70/30으로 혼합되어 최상위 트레이더들이 모두 100에 몰리지 않도록 합니다.

## 조작에 강한 이유

- **ROI는 압축됩니다** — 300%와 10,000% 수익이 거의 나란히 놓이므로 작은 계좌로 상위권을 차지할 수 없습니다
- **PnL은 진짜 돈을 보상합니다** — 작은 계좌는 0점에 가깝습니다
- **신뢰도가 빈약한 실적에 상한을 겁니다** — 몇 건의 거래로 상위 순위를 살 수 없습니다

이를 통해 리더보드는 정직하게 유지됩니다: 일관되고 자본이 충분하며 리스크를 인식하는 트레이더가 상위로 올라갑니다.
    `.trim(),
    },
  },
  {
    slug: 'understanding-trader-rankings',
    title: {
      en: 'Understanding Crypto Trader Rankings',
      zh: '读懂加密交易员排名',
      ja: '暗号資産トレーダーのランキングを理解する',
      ko: '암호화폐 트레이더 랭킹 이해하기',
    },
    excerpt: {
      en: 'How Arena aggregates live CEX, DEX, and on-chain source boards into a unified leaderboard.',
      zh: 'Arena 如何将当前有数据的 CEX、DEX 与链上来源板聚合为一个统一排行榜。',
      ja: 'Arena が稼働中の CEX・DEX・オンチェーンのソースボードを統合ランキングにまとめる仕組み。',
      ko: 'Arena가 운영 중인 CEX, DEX 및 온체인 소스 보드를 하나의 통합 리더보드로 집계하는 방법.',
    },
    content: {
      en: `
# Understanding Crypto Trader Rankings

Arena aggregates trader performance data from **live CEX, DEX, and on-chain source boards** into a unified leaderboard.

## Data Collection

Every few hours, our pipeline collects the latest available public API, webpage, protocol, or on-chain data for each source. This includes:
- **ROI** (Return on Investment) across multiple timeframes
- **PnL** (Profit and Loss) in USD
- **Win rate**, **max drawdown**, and other risk metrics when available

## Normalization

Different exchanges report data differently. Some give ROI as a decimal (0.25), others as a percentage (25%). Arena normalizes all data into consistent units before scoring.

## Ranking Methodology

1. **Collect**: Store raw data and source/window evidence
2. **Normalize**: Convert to standard units (ROI in %, PnL in USD)
3. **Gate**: Reject incomplete or methodology-incompatible metrics
4. **Score**: Calculate Arena Score for each trader in the selected timeframe
5. **Rank**: Sort the selected timeframe, grouping ties

## Period Switching

You can view rankings for different periods:
- **7 Days**: Recent hot performers
- **30 Days**: Medium-term consistency
- **90 Days**: Longer track record (default view)
    `.trim(),
      zh: `
# 读懂加密交易员排名

Arena 将来自**当前有数据的 CEX、DEX 与链上来源板**的交易员表现数据聚合为一个统一排行榜。

## 数据采集

每隔几小时，流水线会采集各来源最新可用的公开 API、网页、协议或链上数据，包括：
- 多个时间段的 **ROI**（投资回报率）
- 以美元计的 **PnL**（盈亏）
- 在可获取时的 **胜率**、**最大回撤** 及其他风险指标

## 归一化

不同交易所上报数据的方式各异。有的把 ROI 记为小数（0.25），有的记为百分比（25%）。Arena 在评分前会将所有数据归一化为一致的单位。

## 排名方法

1. **采集**：保存原始数据及来源/窗口证据
2. **归一化**：转换为标准单位（ROI 用 %，PnL 用美元）
3. **质量门**：拒绝不完整或方法口径不兼容的指标
4. **评分**：为每位交易员计算所选时间段的 Arena 评分
5. **排名**：按所选时间段排序，并对并列进行分组

## 时间段切换

你可以查看不同时间段的排名：
- **7 天**：近期热门表现者
- **30 天**：中期稳定性
- **90 天**：更长的战绩窗口（默认视图）
    `.trim(),
      ja: `
# 暗号資産トレーダーのランキングを理解する

Arena は**稼働中の CEX・DEX・オンチェーンのソースボード**のパフォーマンスデータを、統合リーダーボードにまとめます。

## データ収集

数時間おきに、パイプラインは各ソースの最新の公開 API、ウェブページ、プロトコル、またはオンチェーンデータを取得します。これには次が含まれます：
- 複数の期間にわたる **ROI**（投資収益率）
- USD 建ての **PnL**（損益）
- 取得可能な場合の **勝率**、**最大ドローダウン**、その他のリスク指標

## 正規化

取引所ごとにデータの報告方法は異なります。ROI を小数（0.25）で示すところもあれば、パーセンテージ（25%）で示すところもあります。Arena は採点の前に、すべてのデータを一貫した単位に正規化します。

## ランキングの方法論

1. **収集**：RAW データとソース・期間の証拠を保存
2. **正規化**：標準単位に変換（ROI は %、PnL は USD）
3. **品質ゲート**：不完全または方法論的に互換性のない指標を拒否
4. **採点**：選択した期間の Arena スコアを計算
5. **ランク付け**：選択した期間で並べ替え、同点はグループ化

## 期間の切り替え

さまざまな期間のランキングを表示できます：
- **7 日間**：直近の好調なトレーダー
- **30 日間**：中期的な一貫性
- **90 日間**：より長い実績期間（デフォルト表示）
    `.trim(),
      ko: `
# 암호화폐 트레이더 랭킹 이해하기

Arena는 **운영 중인 CEX, DEX 및 온체인 소스 보드**의 성과 데이터를 통합 리더보드로 집계합니다.

## 데이터 수집

몇 시간마다 파이프라인은 각 소스의 최신 공개 API, 웹페이지, 프로토콜 또는 온체인 데이터를 수집합니다. 여기에는 다음이 포함됩니다:
- 여러 기간에 걸친 **ROI**(투자 수익률)
- USD 기준 **PnL**(손익)
- 가능한 경우 **승률**, **최대 드로다운** 및 기타 리스크 지표

## 정규화

거래소마다 데이터를 보고하는 방식이 다릅니다. 어떤 곳은 ROI를 소수(0.25)로, 어떤 곳은 백분율(25%)로 제공합니다. Arena는 채점 전에 모든 데이터를 일관된 단위로 정규화합니다.

## 랭킹 방법론

1. **수집**: 원시 데이터와 소스/기간 증거 저장
2. **정규화**: 표준 단위로 변환(ROI는 %, PnL은 USD)
3. **품질 게이트**: 불완전하거나 방법론이 호환되지 않는 지표 거부
4. **채점**: 선택한 기간의 Arena 점수 계산
5. **순위 매기기**: 선택한 기간으로 정렬하고 동점은 그룹화

## 기간 전환

여러 기간의 랭킹을 볼 수 있습니다:
- **7일**: 최근 뜨거운 성과자
- **30일**: 중기 일관성
- **90일**: 더 긴 실적 기간(기본 보기)
    `.trim(),
    },
  },
  {
    slug: 'cex-vs-dex',
    title: {
      en: 'CEX vs DEX: Comparing Exchange Types',
      zh: 'CEX 与 DEX：交易所类型对比',
      ja: 'CEX と DEX：取引所タイプの比較',
      ko: 'CEX vs DEX: 거래소 유형 비교',
    },
    excerpt: {
      en: 'Learn the differences between centralized and decentralized exchanges, and how Arena ranks traders across both.',
      zh: '了解中心化与去中心化交易所的区别，以及 Arena 如何在两者之间为交易员排名。',
      ja: '中央集権型取引所と分散型取引所の違い、そして Arena が両者のトレーダーをどうランク付けするかを学びましょう。',
      ko: '중앙화 거래소와 탈중앙화 거래소의 차이, 그리고 Arena가 양쪽 트레이더를 어떻게 순위 매기는지 알아보세요.',
    },
    content: {
      en: `
# CEX vs DEX: Comparing Exchange Types

Arena ranks traders from both **centralized exchanges (CEX)** and **decentralized exchanges (DEX)**. Here is how they compare.

## Centralized Exchanges (CEX)

Examples: Binance, Bybit, OKX, Bitget, MEXC

- **Data source**: Public copy-trading leaderboards, APIs, and source pages
- **Account model**: The exchange holds customer funds; KYC and regional access vary
- **Coverage**: Available fields and history vary by exchange, and a public leaderboard is not necessarily the exchange's full trader population

## Decentralized Exchanges (DEX)

Current Arena examples: Hyperliquid, GMX, gTrade

- **Data source**: Official public files/APIs, protocol indexers, and chain events or state
- **Account model**: Wallet-based self-custody and publicly auditable activity; smart-contract, oracle, bridge, and transaction-cost risks vary by protocol and chain
- **Coverage**: A reliable reconstruction needs complete history, cash flows, prices, and a protocol-version-aware decoder; an upstream leaderboard may still be bounded

## How Arena Handles Differences

- **Provenance is preserved** so a native exchange metric is not silently presented as an on-chain reconstruction
- **Compatibility comes before ranking**: only metrics with compatible periods, definitions, and quality are compared; matching units alone do not make two metrics equivalent
- **Confidence reflects evidence** such as sample size and completeness; an unsupported field remains unavailable instead of being guessed

The result is a unified interface across CEX and DEX sources, with comparability limited to what the underlying evidence actually supports.
    `.trim(),
      zh: `
# CEX 与 DEX：交易所类型对比

Arena 同时为来自 **中心化交易所（CEX）** 和 **去中心化交易所（DEX）** 的交易员排名。以下是两者的对比。

## 中心化交易所（CEX）

例如：Binance、Bybit、OKX、Bitget、MEXC

- **数据来源**：公开跟单排行榜、API 与来源页面
- **账户模式**：交易所托管客户资金；KYC 与地区可用性因平台而异
- **覆盖范围**：各交易所公开的字段和历史长度不同，公开排行榜也不一定代表该交易所的全部交易员

## 去中心化交易所（DEX）

Arena 当前示例：Hyperliquid、GMX、gTrade

- **数据来源**：官方公开文件/API、协议索引器，以及链上事件或状态
- **账户模式**：钱包自托管且活动可公开审计；智能合约、预言机、跨链桥与交易成本风险因协议和链而异
- **覆盖范围**：可靠重建需要完整历史、资金流、价格，以及能识别协议版本的解码器；上游排行榜本身仍可能有数量上限

## Arena 如何处理差异

- **保留来源与口径**，不会把交易所原生指标悄悄包装成链上重建指标
- **先验证可比性，再排名**：只有周期、定义与质量兼容的指标才参与比较；单位相同并不代表口径相同
- **置信度反映证据强度**，例如样本量和完整度；不支持的字段保持不可用（底层为 NULL），而不是猜测补值

结果是一个统一展示 CEX 与 DEX 来源的界面，而可比范围不会超过底层证据真正支持的边界。
    `.trim(),
      ja: `
# CEX と DEX：取引所タイプの比較

Arena は **中央集権型取引所（CEX）** と **分散型取引所（DEX）** の両方のトレーダーをランク付けします。両者の比較は以下のとおりです。

## 中央集権型取引所（CEX）

例：Binance、Bybit、OKX、Bitget、MEXC

- **データソース**：公開コピートレード・リーダーボード、API、ソースページ
- **口座モデル**：取引所が顧客資産を管理し、KYC と地域別の利用可否は取引所ごとに異なる
- **カバレッジ**：公開される項目と履歴の長さは取引所ごとに異なり、公開リーダーボードが全トレーダーを表すとは限らない

## 分散型取引所（DEX）

Arena の現在の例：Hyperliquid、GMX、gTrade

- **データソース**：公式の公開ファイル/API、プロトコル・インデクサー、チェーン上のイベントまたは状態
- **口座モデル**：ウォレットによる自己管理で活動を公開検証できる一方、スマートコントラクト、オラクル、ブリッジ、取引コストのリスクはプロトコルとチェーンごとに異なる
- **カバレッジ**：信頼できる再構築には完全な履歴、資金フロー、価格、プロトコルのバージョンを認識するデコーダーが必要で、上流リーダーボード自体に件数上限がある場合もある

## Arena が違いをどう扱うか

- **出所と算出方法を保持**し、取引所のネイティブ指標をオンチェーン再構築値として暗黙に表示しない
- **順位付けより先に比較可能性を確認**し、期間、定義、品質が互換な指標だけを比較する。同じ単位でも同じ算出基準とは限らない
- **信頼度は証拠の強さ**（サンプル数や完全性など）を反映し、未対応の項目は推測せず利用不可のままにする

その結果、CEX と DEX の情報を一つの画面で確認でき、比較可能な範囲は基礎データが実際に裏付ける範囲に限定されます。
    `.trim(),
      ko: `
# CEX vs DEX: 거래소 유형 비교

Arena는 **중앙화 거래소(CEX)** 와 **탈중앙화 거래소(DEX)** 양쪽의 트레이더를 순위 매깁니다. 둘의 비교는 다음과 같습니다.

## 중앙화 거래소(CEX)

예: Binance, Bybit, OKX, Bitget, MEXC

- **데이터 출처**: 공개 카피 트레이딩 리더보드, API, 출처 페이지
- **계정 모델**: 거래소가 고객 자금을 보관하며 KYC와 지역별 이용 가능 여부는 거래소마다 다름
- **커버리지**: 공개 필드와 이력 길이는 거래소마다 다르고, 공개 리더보드가 전체 트레이더 모집단을 뜻하지는 않음

## 탈중앙화 거래소(DEX)

현재 Arena 예시: Hyperliquid, GMX, gTrade

- **데이터 출처**: 공식 공개 파일/API, 프로토콜 인덱서, 체인 이벤트 또는 상태
- **계정 모델**: 지갑 기반 자체 보관과 공개 검증이 가능하지만 스마트 컨트랙트, 오라클, 브리지, 거래 비용 위험은 프로토콜과 체인마다 다름
- **커버리지**: 신뢰할 수 있는 재구축에는 완전한 이력, 자금 흐름, 가격, 프로토콜 버전을 인식하는 디코더가 필요하며 상위 리더보드 자체에 건수 제한이 있을 수도 있음

## Arena가 차이를 처리하는 방법

- **출처와 산출 방법을 보존**해 거래소의 네이티브 지표를 온체인 재구축 값처럼 암묵적으로 표시하지 않음
- **순위보다 비교 가능성을 먼저 확인**하고 기간, 정의, 품질이 호환되는 지표만 비교함. 단위가 같다고 산출 기준까지 같은 것은 아님
- **신뢰도는 표본 수와 완전성 같은 근거의 강도**를 반영하며, 지원하지 않는 필드는 추정하지 않고 사용할 수 없는 상태로 유지함

그 결과 CEX와 DEX 출처를 하나의 화면에서 볼 수 있으며, 비교 범위는 기반 근거가 실제로 뒷받침하는 수준으로 제한됩니다.
    `.trim(),
    },
  },
  {
    slug: 'reading-risk-metrics',
    title: {
      en: 'Reading Risk Metrics',
      zh: '解读风险指标',
      ja: 'リスク指標の読み方',
      ko: '리스크 지표 읽기',
    },
    excerpt: {
      en: 'What drawdown, Sharpe ratio, and win rate really mean, and how to use them to evaluate traders.',
      zh: '回撤、夏普比率和胜率究竟意味着什么，以及如何用它们来评估交易员。',
      ja: 'ドローダウン、シャープレシオ、勝率が本当は何を意味するのか、そしてそれらでトレーダーを評価する方法。',
      ko: '드로다운, 샤프 지수, 승률이 실제로 무엇을 의미하는지, 그리고 이를 활용해 트레이더를 평가하는 방법.',
    },
    content: {
      en: `
# Reading Risk Metrics

High returns mean nothing without understanding risk. Arena provides several risk metrics to help you evaluate traders beyond just ROI.

## Max Drawdown

The largest peak-to-trough decline in a trader's equity. A 30% max drawdown means the trader's account dropped 30% from its highest point before recovering.

- **< 10%**: Very conservative
- **10-25%**: Moderate risk
- **25-50%**: Aggressive
- **> 50%**: Very high risk

## Sharpe Ratio

Measures risk-adjusted return — how much return per unit of volatility.

\`Sharpe = (Average Return - Risk-Free Rate) / Standard Deviation of Returns\`

- **< 0.5**: Poor risk-adjusted returns
- **0.5-1.0**: Acceptable
- **1.0-2.0**: Good
- **> 2.0**: Excellent

Arena computes Sharpe from daily returns over the relevant period.

## Win Rate

The percentage of profitable trading days. A 60% win rate means the trader was profitable on 6 out of 10 days.

- **> 65%**: Consistently profitable
- **50-65%**: Average (can still be very profitable with good risk/reward)
- **< 50%**: Loses more often than wins (may still profit if winners are larger)

## Using Metrics Together

A trader with 200% ROI but 80% max drawdown is far riskier than one with 50% ROI and 15% drawdown. Always look at the full picture: ROI, drawdown, Sharpe, and win rate together tell the real story.
    `.trim(),
      zh: `
# 解读风险指标

若不理解风险，高收益毫无意义。Arena 提供多项风险指标，帮助你在 ROI 之外评估交易员。

## 最大回撤

交易员权益从峰值到谷底的最大跌幅。30% 的最大回撤意味着账户从最高点下跌了 30% 后才恢复。

- **< 10%**：非常保守
- **10-25%**：中等风险
- **25-50%**：激进
- **> 50%**：极高风险

## 夏普比率

衡量风险调整后收益——每单位波动带来多少收益。

\`夏普 = (平均收益 - 无风险利率) / 收益的标准差\`

- **< 0.5**：风险调整后收益较差
- **0.5-1.0**：可以接受
- **1.0-2.0**：良好
- **> 2.0**：优秀

Arena 根据相应时间段的每日收益计算夏普比率。

## 胜率

盈利交易日的百分比。60% 的胜率意味着交易员在 10 天中有 6 天盈利。

- **> 65%**：持续盈利
- **50-65%**：一般（若盈亏比良好仍可非常盈利）
- **< 50%**：亏损天数多于盈利天数（若盈利更大仍可能盈利）

## 综合使用各项指标

一位 200% ROI 但 80% 最大回撤的交易员，远比 50% ROI、15% 回撤的交易员风险更高。请始终看全貌：ROI、回撤、夏普和胜率共同讲述真实的故事。
    `.trim(),
      ja: `
# リスク指標の読み方

リスクを理解しなければ、高いリターンには意味がありません。Arena は ROI だけにとどまらずトレーダーを評価できるよう、いくつかのリスク指標を提供します。

## 最大ドローダウン

トレーダーの資産における山から谷への最大の下落幅です。最大ドローダウン 30% は、口座が最高値から 30% 下落してから回復したことを意味します。

- **< 10%**：非常に保守的
- **10-25%**：中程度のリスク
- **25-50%**：積極的
- **> 50%**：非常に高リスク

## シャープレシオ

リスク調整後リターンを測定します——ボラティリティ 1 単位あたりのリターンです。

\`シャープ = (平均リターン - 無リスク金利) / リターンの標準偏差\`

- **< 0.5**：リスク調整後リターンが低い
- **0.5-1.0**：許容範囲
- **1.0-2.0**：良好
- **> 2.0**：優秀

Arena は該当期間の日次リターンからシャープを計算します。

## 勝率

利益が出た取引日の割合です。勝率 60% は、10 日のうち 6 日で利益を出したことを意味します。

- **> 65%**：安定して利益が出ている
- **50-65%**：平均的（リスクリワードが良ければ十分に利益を出せる）
- **< 50%**：勝つより負ける日が多い（勝ちが大きければ利益が出ることもある）

## 指標を組み合わせて使う

ROI 200% でも最大ドローダウン 80% のトレーダーは、ROI 50%・ドローダウン 15% のトレーダーよりはるかにリスクが高いです。常に全体像を見ましょう：ROI、ドローダウン、シャープ、勝率をまとめて見ることで、本当の姿が分かります。
    `.trim(),
      ko: `
# 리스크 지표 읽기

리스크를 이해하지 못하면 높은 수익은 아무 의미가 없습니다. Arena는 ROI만이 아니라 트레이더를 평가할 수 있도록 여러 리스크 지표를 제공합니다.

## 최대 드로다운

트레이더 자산의 최고점 대비 최대 하락폭입니다. 최대 드로다운 30%는 계좌가 최고점에서 30% 하락한 뒤 회복했음을 의미합니다.

- **< 10%**: 매우 보수적
- **10-25%**: 중간 리스크
- **25-50%**: 공격적
- **> 50%**: 매우 높은 리스크

## 샤프 지수

리스크 조정 수익을 측정합니다——변동성 1단위당 얼마의 수익을 내는가입니다.

\`샤프 = (평균 수익 - 무위험 금리) / 수익의 표준편차\`

- **< 0.5**: 리스크 조정 수익이 낮음
- **0.5-1.0**: 허용 가능
- **1.0-2.0**: 좋음
- **> 2.0**: 우수

Arena는 해당 기간의 일별 수익으로 샤프를 계산합니다.

## 승률

수익이 난 거래일의 비율입니다. 승률 60%는 10일 중 6일 수익을 냈다는 뜻입니다.

- **> 65%**: 꾸준히 수익
- **50-65%**: 평균(손익비가 좋으면 여전히 크게 수익 가능)
- **< 50%**: 이기는 날보다 지는 날이 많음(이익이 크면 여전히 수익 가능)

## 지표를 함께 사용하기

ROI 200%이지만 최대 드로다운 80%인 트레이더는 ROI 50%에 드로다운 15%인 트레이더보다 훨씬 위험합니다. 항상 전체 그림을 보세요: ROI, 드로다운, 샤프, 승률을 함께 보아야 진짜 이야기가 드러납니다.
    `.trim(),
    },
  },
  {
    slug: 'getting-started',
    title: {
      en: 'Getting Started with Arena',
      zh: 'Arena 新手入门',
      ja: 'Arena をはじめよう',
      ko: 'Arena 시작하기',
    },
    excerpt: {
      en: 'A quick guide to navigating Arena, finding top traders, following them, and going Pro.',
      zh: '快速指南：如何浏览 Arena、发现顶级交易员、关注他们并升级 Pro。',
      ja: 'Arena の使い方、トップトレーダーの見つけ方、フォロー方法、Pro へのアップグレードを解説するクイックガイド。',
      ko: 'Arena 탐색, 상위 트레이더 찾기, 팔로우, Pro 업그레이드까지 안내하는 빠른 가이드.',
    },
    content: {
      en: `
# Getting Started with Arena

Welcome to Arena! Here is how to get the most out of the platform.

## 1. Browse Rankings

The homepage shows the **global leaderboard** — every ranked trader ordered by Arena Score. Use the period selector to switch between 7D, 30D, and 90D views.

## 2. Filter by Exchange

Click on any exchange name in the rankings to see only traders from that platform. You can also use the exchange filter dropdown to narrow results.

## 3. View Trader Profiles

Click on any trader to see their detailed profile including:
- Performance chart over time
- Risk metrics (drawdown, Sharpe, win rate)
- Trading style analysis
- Arena Score breakdown

## 4. Follow Traders

Create a free account and follow traders to:
- Build a personalized watchlist
- Track their performance over time
- Get notified of significant changes

## 5. Go Pro

Arena Pro unlocks:
- **Advanced analytics**: Deeper risk metrics and performance comparisons
- **Alerts**: Get notified when followed traders have unusual activity
- **Trader comparison**: Compare up to 4 traders side by side
- **Export data**: Download rankings and performance data

Visit the pricing page to learn more about Pro membership.

## 6. Join the Community

Arena has a built-in social layer. Join groups, post trade ideas, and discuss strategies with other traders.
    `.trim(),
      zh: `
# Arena 新手入门

欢迎来到 Arena！以下是充分利用本平台的方法。

## 1. 浏览排名

首页展示 **全球排行榜**——所有已排名交易员按 Arena 评分排序。使用时间段选择器可在 7D、30D 和 90D 视图间切换。

## 2. 按交易所筛选

点击排名中任意交易所名称，即可只查看该平台的交易员。你也可以使用交易所筛选下拉框来缩小结果。

## 3. 查看交易员资料

点击任意交易员即可查看其详细资料，包括：
- 随时间变化的表现图表
- 风险指标（回撤、夏普、胜率）
- 交易风格分析
- Arena 评分构成拆解

## 4. 关注交易员

创建一个免费账户并关注交易员，即可：
- 建立个性化的关注列表
- 追踪他们随时间的表现
- 在出现重大变化时收到通知

## 5. 升级 Pro

Arena Pro 解锁：
- **高级分析**：更深入的风险指标与表现对比
- **提醒**：当关注的交易员出现异常活动时收到通知
- **交易员对比**：最多可并排对比 4 位交易员
- **数据导出**：下载排名与表现数据

访问定价页面，了解更多关于 Pro 会员的信息。

## 6. 加入社区

Arena 内置社交层。加入群组、发布交易想法，并与其他交易员讨论策略。
    `.trim(),
      ja: `
# Arena をはじめよう

Arena へようこそ！プラットフォームを最大限に活用する方法を紹介します。

## 1. ランキングを見る

ホームページには **グローバルリーダーボード** が表示されます——ランク付けされた全トレーダーが Arena スコア順に並びます。期間セレクターで 7D、30D、90D の表示を切り替えられます。

## 2. 取引所で絞り込む

ランキング内の取引所名をクリックすると、そのプラットフォームのトレーダーだけを表示できます。取引所フィルターのドロップダウンで結果を絞り込むこともできます。

## 3. トレーダーのプロフィールを見る

任意のトレーダーをクリックすると、次を含む詳細なプロフィールが見られます：
- 時系列のパフォーマンスチャート
- リスク指標（ドローダウン、シャープ、勝率）
- トレードスタイル分析
- Arena スコアの内訳

## 4. トレーダーをフォローする

無料アカウントを作成してトレーダーをフォローすると：
- 自分専用のウォッチリストを作成できます
- 時系列でパフォーマンスを追跡できます
- 大きな変化があった際に通知を受け取れます

## 5. Pro にアップグレード

Arena Pro で解放される機能：
- **高度な分析**：より深いリスク指標とパフォーマンス比較
- **アラート**：フォロー中のトレーダーに異常な動きがあると通知
- **トレーダー比較**：最大 4 人のトレーダーを並べて比較
- **データエクスポート**：ランキングとパフォーマンスデータをダウンロード

Pro メンバーシップの詳細は料金ページをご覧ください。

## 6. コミュニティに参加する

Arena には組み込みのソーシャルレイヤーがあります。グループに参加し、トレードのアイデアを投稿し、他のトレーダーと戦略を議論しましょう。
    `.trim(),
      ko: `
# Arena 시작하기

Arena에 오신 것을 환영합니다! 플랫폼을 최대한 활용하는 방법을 소개합니다.

## 1. 랭킹 둘러보기

홈페이지에는 **글로벌 리더보드** 가 표시됩니다——순위가 매겨진 모든 트레이더가 Arena 점수 순으로 정렬됩니다. 기간 선택기로 7D, 30D, 90D 보기를 전환하세요.

## 2. 거래소별 필터링

랭킹에서 거래소 이름을 클릭하면 해당 플랫폼의 트레이더만 볼 수 있습니다. 거래소 필터 드롭다운으로 결과를 좁힐 수도 있습니다.

## 3. 트레이더 프로필 보기

아무 트레이더나 클릭하면 다음을 포함한 상세 프로필을 볼 수 있습니다:
- 시간에 따른 성과 차트
- 리스크 지표(드로다운, 샤프, 승률)
- 트레이딩 스타일 분석
- Arena 점수 구성 분석

## 4. 트레이더 팔로우

무료 계정을 만들고 트레이더를 팔로우하면:
- 개인화된 관심 목록을 만들 수 있습니다
- 시간에 따른 성과를 추적할 수 있습니다
- 중요한 변화가 있을 때 알림을 받습니다

## 5. Pro로 업그레이드

Arena Pro가 잠금 해제하는 것:
- **고급 분석**: 더 깊은 리스크 지표와 성과 비교
- **알림**: 팔로우한 트레이더에게 이례적인 활동이 있을 때 알림
- **트레이더 비교**: 최대 4명의 트레이더를 나란히 비교
- **데이터 내보내기**: 랭킹과 성과 데이터 다운로드

Pro 멤버십에 대한 자세한 내용은 요금 페이지를 참고하세요.

## 6. 커뮤니티 참여

Arena에는 내장 소셜 레이어가 있습니다. 그룹에 참여하고, 매매 아이디어를 올리고, 다른 트레이더와 전략을 논의해 보세요.
    `.trim(),
    },
  },
  {
    slug: 'top-traders-by-exchange',
    title: {
      en: 'Top Traders by Exchange: Who Leads Each Platform?',
      zh: '各交易所顶级交易员：谁在领跑每个平台？',
      ja: '取引所別トップトレーダー：各プラットフォームの首位は誰か？',
      ko: '거래소별 상위 트레이더: 각 플랫폼의 선두는 누구인가?',
    },
    excerpt: {
      en: 'A methodology-aware view across live CEX, DEX, and on-chain source boards.',
      zh: '对当前有数据的 CEX、DEX 与链上来源板进行方法感知分析。',
      ja: '稼働中の CEX・DEX・オンチェーンのソースボードを方法論込みで比較します。',
      ko: '운영 중인 CEX, DEX 및 온체인 소스 보드를 방법론에 맞춰 비교합니다.',
    },
    content: {
      en: `
# Top Traders by Exchange

Arena tracks **live CEX, DEX, and on-chain source boards**. Rankings only compare metrics that pass source-specific methodology and quality gates.

## CEX Sources
- **Binance Futures**: Arena records public leaderboard and profile evidence while preserving the exchange's native windows and source identifiers.
- **Bybit**: Public copy-trading board and profile metrics are normalized only after their period and field definitions pass validation.
- **OKX Futures**: Public board and profile fields are retained with their source context; fields that are not exposed remain unavailable.

## DEX Sources
- **Hyperliquid**: Arena uses its public leaderboard and account data today; node/S3 indexing is the path to complete historical fills and cash flows.
- **GMX**: Arena's current serving source is Arbitrum. The protocol also has active deployments on Avalanche and MegaETH, which are tracked separately from serving scope.
- **gTrade**: Arena currently serves its Arbitrum public board and verified profile windows; bounded Top-25 boards are not treated as the complete trader population.

## How to Compare
Use Arena's **Platform Stats** (/api/rankings/platform-stats) to see aggregate ROI, score, and ranked-row counts by source. Treat these as a snapshot of Arena's eligible data, not the platform's complete user population or an investment recommendation.

## Key Insight
Do not infer performance from a CEX/DEX label. ROI capital bases, realized-versus-unrealized PnL, window boundaries, and missing risk data differ by source, so Arena only compares compatible, quality-gated metrics.
    `.trim(),
      zh: `
# 各交易所顶级交易员

Arena 追踪**当前有数据的 CEX、DEX 与链上来源板**。只有通过来源方法与质量门的指标才会进入对比。

## CEX 来源
- **Binance Futures**：Arena 记录公开排行榜与主页证据，同时保留交易所原生窗口和来源标识。
- **Bybit**：公开跟单榜单与主页指标只有在周期和字段定义通过验证后才会归一化。
- **OKX Futures**：公开榜单与主页字段会连同来源上下文一起保留；来源未公开的字段保持不可用。

## DEX 来源
- **Hyperliquid**：Arena 当前使用公开榜单和账户数据；完整历史 fills 与资金流将由 node/S3 索引补齐。
- **GMX**：Arena 当前 serving source 是 Arbitrum；协议还活跃部署于 Avalanche 与 MegaETH，协议范围与 serving 范围分开统计。
- **gTrade**：Arena 当前服务 Arbitrum 公开榜单和通过覆盖门的主页窗口；Top-25 榜单不能冒充完整交易员人口。

## 如何对比
使用 Arena 的 **平台统计**（/api/rankings/platform-stats）查看各来源聚合后的 ROI、分数与入榜行数。它们是 Arena 合格数据的一个快照，不代表平台全部用户人口，也不是投资建议。

## 关键洞见
不能从 CEX/DEX 标签推断表现。ROI 资本基数、PnL 是否含未实现部分、窗口边界和风险字段完整度都可能不同；Arena 只比较方法兼容且通过质量门的指标。
    `.trim(),
      ja: `
# 取引所別トップトレーダー

Arena は**稼働中の CEX・DEX・オンチェーンのソースボード**を追跡しています。ソース固有の方法論と品質ゲートを通過した指標だけを比較します。

## CEX ソース
- **Binance Futures**：Arena は公開リーダーボードとプロフィールの証拠を記録し、取引所固有の期間とソース ID を保持します。
- **Bybit**：公開コピートレード・ボードとプロフィール指標は、期間と項目の定義が検証を通過した後にのみ正規化されます。
- **OKX Futures**：公開ボードとプロフィールの項目はソースの文脈とともに保持され、公開されていない項目は未取得のままです。

## DEX ソース
- **Hyperliquid**：Arena は現在、公開リーダーボードとアカウントデータを利用しています。完全な履歴 fills と資金フローは node/S3 索引で補完します。
- **GMX**：Arena の現在の serving source は Arbitrum です。プロトコルは Avalanche と MegaETH にもアクティブなデプロイがあり、serving 範囲とは分けて扱います。
- **gTrade**：Arena は現在 Arbitrum の公開ボードと検証済みプロフィール期間を提供します。Top-25 ボードを完全なトレーダー人口とは見なしません。

## 比較の仕方
Arena の **プラットフォーム統計**（/api/rankings/platform-stats）では、ソース別に集計された ROI、スコア、ランク対象行数を確認できます。これは Arena の適格データのスナップショットであり、プラットフォームの全ユーザー数でも投資推奨でもありません。

## 重要な洞察
CEX/DEX というラベルだけで成績を推測してはいけません。ROI の資本基準、実現・未実現 PnL、期間境界、リスクデータの完全性がソースごとに異なるため、Arena は方法論的に互換で品質ゲートを通過した指標だけを比較します。
    `.trim(),
      ko: `
# 거래소별 상위 트레이더

Arena는 **운영 중인 CEX, DEX 및 온체인 소스 보드**를 추적합니다. 소스별 방법론과 품질 게이트를 통과한 지표만 비교합니다.

## CEX 소스
- **Binance Futures**: Arena는 공개 리더보드와 프로필 근거를 기록하면서 거래소 고유 기간과 소스 식별자를 보존합니다.
- **Bybit**: 공개 카피 트레이딩 보드와 프로필 지표는 기간과 필드 정의가 검증을 통과한 뒤에만 정규화됩니다.
- **OKX Futures**: 공개 보드와 프로필 필드는 소스 맥락과 함께 보존되며, 공개되지 않은 필드는 사용할 수 없는 상태로 유지됩니다.

## DEX 소스
- **Hyperliquid**: Arena는 현재 공개 리더보드와 계정 데이터를 사용합니다. 완전한 과거 fills와 자금 흐름은 node/S3 인덱싱으로 보완합니다.
- **GMX**: Arena의 현재 serving source는 Arbitrum입니다. 프로토콜은 Avalanche와 MegaETH에도 활성 배포되어 있으며 serving 범위와 분리해 집계합니다.
- **gTrade**: Arena는 현재 Arbitrum 공개 보드와 검증된 프로필 기간을 제공합니다. Top-25 보드를 전체 트레이더 인구로 간주하지 않습니다.

## 비교 방법
Arena의 **플랫폼 통계**(/api/rankings/platform-stats)에서 소스별 집계 ROI, 점수, 랭킹 대상 행 수를 확인할 수 있습니다. 이는 Arena의 적격 데이터 스냅샷이며 플랫폼 전체 사용자 수나 투자 권유가 아닙니다.

## 핵심 인사이트
CEX/DEX 라벨만으로 성과를 추정하면 안 됩니다. ROI 자본 기준, 실현·미실현 PnL, 기간 경계, 리스크 데이터 완전성이 소스마다 다르므로 Arena는 방법론이 호환되고 품질 게이트를 통과한 지표만 비교합니다.
    `.trim(),
    },
  },
  {
    slug: 'what-is-copy-trading',
    title: {
      en: "What is Copy Trading? A Beginner's Guide",
      zh: '什么是跟单交易？新手指南',
      ja: 'コピートレードとは？初心者ガイド',
      ko: '카피 트레이딩이란? 초보자 가이드',
    },
    excerpt: {
      en: 'Learn how copy trading works, its benefits and risks, and how Arena helps you find the best traders to follow.',
      zh: '了解跟单交易的运作方式、优势与风险，以及 Arena 如何帮你找到最值得跟随的交易员。',
      ja: 'コピートレードの仕組み、メリットとリスク、そして Arena がフォローすべき優れたトレーダーを見つける手助けをする方法を学びましょう。',
      ko: '카피 트레이딩의 작동 방식, 장점과 위험, 그리고 Arena가 팔로우할 최고의 트레이더를 찾도록 돕는 방법을 알아보세요.',
    },
    content: {
      en: `
# What is Copy Trading?

Copy trading lets you automatically replicate the trades of experienced traders. When they buy, you buy. When they sell, you sell. It's like having a professional manage your portfolio.

## How It Works
1. **Browse rankings** on Arena to find top-performing traders
2. **Analyze their profile** — check ROI, drawdown, win rate, and trading style
3. **Follow them** on their exchange's copy-trading platform (Binance, Bybit, OKX, etc.)
4. **Set your allocation** — decide how much capital to allocate

## Benefits
- **No experience needed**: Let proven traders make decisions
- **Diversification**: Follow multiple traders across different styles
- **Transparency**: See real-time performance before committing

## Risks
- **Past performance ≠ future results**: Even top traders have losing streaks
- **Drawdown risk**: A 50% drawdown means you need 100% gain to recover
- **Slippage**: Your fills may differ from the trader you're copying

## How Arena Helps
Arena's **Arena Score** combines profit, risk, and confidence into a single risk-adjusted metric. Use filters like "Low Risk" (low drawdown) or "Consistent" (high win rate) to find traders matching your risk tolerance.

> **Pro tip**: Don't put all your capital with one trader. Spread across 3-5 traders with different trading styles for better risk management.
    `.trim(),
      zh: `
# 什么是跟单交易？

跟单交易让你自动复制经验丰富的交易员的操作。他们买入，你也买入；他们卖出，你也卖出。这就像有一位专业人士替你管理投资组合。

## 运作方式
1. 在 Arena **浏览排名**，找到表现最佳的交易员
2. **分析其资料**——查看 ROI、回撤、胜率和交易风格
3. 在其交易所的跟单平台上（Binance、Bybit、OKX 等）**关注他们**
4. **设置你的配额**——决定投入多少资金

## 优势
- **无需经验**：让经过验证的交易员做决策
- **分散化**：关注多位不同风格的交易员
- **透明性**：在投入前查看实时表现

## 风险
- **过往表现 ≠ 未来结果**：即使是顶级交易员也会有连亏
- **回撤风险**：50% 的回撤意味着你需要 100% 的收益才能回本
- **滑点**：你的成交价可能与所跟随的交易员不同

## Arena 如何帮助你
Arena 的 **Arena 评分** 将盈利、风险与置信度整合为单一的风险调整指标。使用「低风险」（低回撤）或「稳定」（高胜率）等筛选条件，找到与你风险承受能力匹配的交易员。

> **专业提示**：不要把全部资金押在一位交易员身上。分散到 3-5 位不同交易风格的交易员，以获得更好的风险管理。
    `.trim(),
      ja: `
# コピートレードとは？

コピートレードは、経験豊富なトレーダーの取引を自動的に複製できる仕組みです。相手が買えばあなたも買い、相手が売ればあなたも売ります。プロにポートフォリオを運用してもらうようなものです。

## 仕組み
1. Arena で **ランキングを見て**、成績優秀なトレーダーを見つける
2. **プロフィールを分析** ——ROI、ドローダウン、勝率、トレードスタイルを確認
3. 取引所のコピートレードプラットフォーム（Binance、Bybit、OKX など）で **フォロー** する
4. **配分を設定** ——どれだけの資金を割り当てるか決める

## メリット
- **経験不要**：実績あるトレーダーに判断を任せられる
- **分散**：異なるスタイルの複数のトレーダーをフォローできる
- **透明性**：資金を投じる前にリアルタイムのパフォーマンスを確認できる

## リスク
- **過去の成績 ≠ 将来の結果**：トップトレーダーでも連敗はある
- **ドローダウンリスク**：50% のドローダウンは、回復に 100% の利益が必要という意味
- **スリッページ**：あなたの約定は、コピー元のトレーダーと異なる場合がある

## Arena の役立ち方
Arena の **Arena スコア** は、利益・リスク・信頼度を単一のリスク調整指標に統合します。「低リスク」（低ドローダウン）や「安定」（高勝率）などのフィルターを使い、自分のリスク許容度に合うトレーダーを見つけましょう。

> **プロのヒント**：全資金を 1 人のトレーダーに預けないこと。スタイルの異なる 3〜5 人に分散させると、リスク管理が向上します。
    `.trim(),
      ko: `
# 카피 트레이딩이란?

카피 트레이딩은 경험 많은 트레이더의 거래를 자동으로 복제할 수 있게 해줍니다. 그들이 사면 당신도 사고, 그들이 팔면 당신도 팝니다. 전문가가 당신의 포트폴리오를 운용해 주는 것과 같습니다.

## 작동 방식
1. Arena에서 **랭킹을 둘러보고** 성과가 뛰어난 트레이더를 찾습니다
2. **프로필을 분석** ——ROI, 드로다운, 승률, 트레이딩 스타일을 확인합니다
3. 해당 거래소의 카피 트레이딩 플랫폼(Binance, Bybit, OKX 등)에서 **팔로우** 합니다
4. **배분을 설정** ——얼마의 자본을 배정할지 정합니다

## 장점
- **경험 불필요**: 검증된 트레이더에게 결정을 맡깁니다
- **분산**: 서로 다른 스타일의 여러 트레이더를 팔로우합니다
- **투명성**: 투자하기 전에 실시간 성과를 확인합니다

## 위험
- **과거 성과 ≠ 미래 결과**: 최고의 트레이더도 연패할 수 있습니다
- **드로다운 위험**: 50% 드로다운은 회복하려면 100% 수익이 필요하다는 뜻입니다
- **슬리피지**: 당신의 체결가는 복제 대상 트레이더와 다를 수 있습니다

## Arena가 돕는 방법
Arena의 **Arena 점수** 는 수익, 리스크, 신뢰도를 하나의 리스크 조정 지표로 결합합니다. 「저위험」(낮은 드로다운)이나 「일관성」(높은 승률) 같은 필터를 사용해 자신의 위험 감내 수준에 맞는 트레이더를 찾으세요.

> **프로 팁**: 모든 자본을 한 트레이더에게 몰지 마세요. 스타일이 다른 3~5명에게 분산하면 리스크 관리가 개선됩니다.
    `.trim(),
    },
  },
  {
    slug: 'trading-styles-explained',
    title: {
      en: 'Trading Styles Explained: Scalper, Swing, Trend, Position',
      zh: '交易风格详解：剥头皮、波段、趋势、头寸',
      ja: 'トレードスタイル徹底解説：スキャルピング、スイング、トレンド、ポジション',
      ko: '트레이딩 스타일 완벽 정리: 스캘핑, 스윙, 트렌드, 포지션',
    },
    excerpt: {
      en: 'Understand the four main trading styles and how Arena classifies traders automatically.',
      zh: '了解四种主要交易风格，以及 Arena 如何自动为交易员分类。',
      ja: '4 つの主要なトレードスタイルと、Arena がトレーダーを自動分類する仕組みを理解しましょう。',
      ko: '네 가지 주요 트레이딩 스타일과 Arena가 트레이더를 자동으로 분류하는 방법을 이해해 보세요.',
    },
    content: {
      en: `
# Trading Styles Explained

Arena automatically classifies traders into four styles based on their behavior:

## Scalper (< 4 hours avg hold)
- Opens and closes positions within hours or minutes
- High trade frequency, small gains per trade
- Requires constant market attention
- **Best for**: Volatile markets, high-frequency strategies

## Swing Trader (4 hours - 7 days avg hold)
- Holds positions for days, capturing medium-term moves
- Moderate trade frequency
- Balances analysis time with active management
- **Best for**: Traders who can't watch markets 24/7

## Trend Follower (7 - 30 days avg hold)
- Rides major market trends for weeks
- Lower trade frequency, larger gains per trade
- Requires patience and conviction
- **Best for**: Trending markets, lower time commitment

## Position Trader (> 30 days avg hold)
- Long-term holding with strategic entry/exit
- Minimal daily management
- Highest risk per trade but potential for largest gains
- **Best for**: Long-term conviction plays

## How Arena Classifies
Arena calculates **average holding hours** from a trader's position history. Combined with trade frequency and win rate patterns, it assigns a style with a **confidence score** (0-100%). You can filter by style on any ranking page.
    `.trim(),
      zh: `
# 交易风格详解

Arena 根据交易员的行为，自动将其归入四种风格：

## 剥头皮（平均持仓 < 4 小时）
- 在数小时或数分钟内开平仓
- 交易频率高，每笔盈利较小
- 需要持续关注市场
- **最适合**：波动剧烈的市场、高频策略

## 波段交易者（平均持仓 4 小时 - 7 天）
- 持仓数天，捕捉中期行情
- 交易频率适中
- 在分析时间与主动管理之间取得平衡
- **最适合**：无法全天候盯盘的交易员

## 趋势跟随者（平均持仓 7 - 30 天）
- 数周内顺应主要市场趋势
- 交易频率较低，每笔盈利较大
- 需要耐心与信念
- **最适合**：趋势行情、时间投入较少者

## 头寸交易者（平均持仓 > 30 天）
- 长期持有，策略性进出场
- 日常管理极少
- 每笔风险最高，但潜在盈利最大
- **最适合**：长期信念型的布局

## Arena 如何分类
Arena 从交易员的持仓历史计算 **平均持仓小时数**。结合交易频率与胜率模式，为其分配一种风格，并附带 **置信度分数**（0-100%）。你可以在任意排名页面按风格筛选。
    `.trim(),
      ja: `
# トレードスタイル徹底解説

Arena はトレーダーの行動に基づいて、自動的に 4 つのスタイルに分類します：

## スキャルパー（平均保有 < 4 時間）
- 数時間または数分でポジションを開閉する
- 取引頻度が高く、1 回あたりの利益は小さい
- 市場を常に注視する必要がある
- **最適な場面**：ボラティリティの高い市場、高頻度戦略

## スイングトレーダー（平均保有 4 時間 - 7 日）
- 数日間ポジションを保有し、中期的な値動きを捉える
- 取引頻度は中程度
- 分析の時間と能動的な管理のバランスを取る
- **最適な場面**：24 時間ずっと市場を見ていられないトレーダー

## トレンドフォロワー（平均保有 7 - 30 日）
- 数週間にわたり主要な市場トレンドに乗る
- 取引頻度は低く、1 回あたりの利益は大きい
- 忍耐と確信が必要
- **最適な場面**：トレンド相場、時間の拘束が少ない場合

## ポジショントレーダー（平均保有 > 30 日）
- 戦略的なエントリー／イグジットで長期保有する
- 日々の管理は最小限
- 1 回あたりのリスクは最も高いが、最大の利益の可能性がある
- **最適な場面**：長期的な確信に基づく戦略

## Arena の分類方法
Arena はトレーダーのポジション履歴から **平均保有時間** を計算します。取引頻度や勝率のパターンと組み合わせ、**信頼度スコア**（0〜100%）付きでスタイルを割り当てます。どのランキングページでもスタイルで絞り込めます。
    `.trim(),
      ko: `
# 트레이딩 스타일 완벽 정리

Arena는 트레이더의 행동을 바탕으로 자동으로 네 가지 스타일로 분류합니다:

## 스캘퍼(평균 보유 < 4시간)
- 몇 시간 또는 몇 분 안에 포지션을 열고 닫음
- 거래 빈도가 높고 거래당 이익은 작음
- 시장을 끊임없이 주시해야 함
- **가장 적합**: 변동성 큰 시장, 고빈도 전략

## 스윙 트레이더(평균 보유 4시간 - 7일)
- 며칠간 포지션을 보유하며 중기 움직임을 포착
- 거래 빈도는 중간
- 분석 시간과 능동적 관리의 균형을 맞춤
- **가장 적합**: 24시간 시장을 볼 수 없는 트레이더

## 트렌드 팔로워(평균 보유 7 - 30일)
- 몇 주에 걸쳐 주요 시장 트렌드에 올라탐
- 거래 빈도는 낮고 거래당 이익은 큼
- 인내와 확신이 필요
- **가장 적합**: 추세 장세, 시간 투입이 적은 경우

## 포지션 트레이더(평균 보유 > 30일)
- 전략적 진입/청산으로 장기 보유
- 일일 관리 최소
- 거래당 위험은 가장 높지만 가장 큰 이익 가능성
- **가장 적합**: 장기 확신 기반 전략

## Arena의 분류 방법
Arena는 트레이더의 포지션 이력에서 **평균 보유 시간** 을 계산합니다. 거래 빈도와 승률 패턴을 결합해 **신뢰도 점수**(0-100%)와 함께 스타일을 부여합니다. 어느 랭킹 페이지에서든 스타일로 필터링할 수 있습니다.
    `.trim(),
    },
  },
  {
    slug: 'how-to-read-equity-curves',
    title: {
      en: 'How to Read Equity Curves and Drawdown Charts',
      zh: '如何解读资金曲线和回撤图',
      ja: 'エクイティカーブとドローダウンチャートの読み方',
      ko: '자산 곡선과 드로다운 차트 읽는 법',
    },
    excerpt: {
      en: 'Learn to interpret the visual charts on trader profiles — equity curves, drawdown depth, and daily returns.',
      zh: '学会解读交易员资料页上的可视化图表——资金曲线、回撤深度和每日收益。',
      ja: 'トレーダープロフィールのビジュアルチャート（エクイティカーブ、ドローダウンの深さ、日次リターン）の読み解き方を学びましょう。',
      ko: '트레이더 프로필의 시각화 차트(자산 곡선, 드로다운 깊이, 일별 수익률)를 해석하는 법을 배워 보세요.',
    },
    content: {
      en: `
# How to Read Equity Curves

Every trader profile on Arena shows several charts. Here's how to interpret them:

## Equity Curve
The main chart showing cumulative ROI over time. A healthy equity curve slopes **upward and to the right** with minimal dips.

**What to look for:**
- **Steady upward slope**: Consistent performance (good)
- **Sharp spikes**: Concentrated gains from few trades (risky)
- **Flat periods**: Trader inactive or in drawdown
- **Vertical drops**: Significant losses

## Drawdown Chart (Underwater Chart)
Shows how far below the peak the portfolio has fallen at any point. Always negative or zero.

**Key metrics:**
- **Max Drawdown**: The deepest the portfolio fell from its peak
- **Recovery time**: How long to recover from the worst drawdown
- **Frequency**: How often drawdowns occur

**Rule of thumb**: A max drawdown of 20% means the trader lost 20% from their best point. They need 25% gain to recover.

## Daily Returns Distribution
A histogram showing how many days had positive vs negative returns.

**What to look for:**
- **Symmetry**: Bell-shaped = consistent. Skewed right = occasional big wins. Skewed left = occasional big losses.
- **Fat tails**: Many extreme days = high volatility
- **Narrow distribution**: Most days near 0% = low volatility, consistent

## Pro Tips
1. Compare 7D, 30D, and 90D curves — short-term performance can differ dramatically from long-term
2. A trader with lower ROI but smaller drawdown may be better for copy-trading (less emotional stress)
3. Check win rate + avg hold time together — a 90% win rate with 1-minute holds might be a bot
    `.trim(),
      zh: `
# 如何解读资金曲线

Arena 上每个交易员的资料页都会展示若干图表。以下是它们的解读方式：

## 资金曲线
展示随时间累计 ROI 的主图。健康的资金曲线呈 **向右上方倾斜**，回落极小。

**要关注什么：**
- **平稳上升的斜率**：表现稳定（好）
- **陡峭的尖峰**：少数交易带来的集中收益（有风险）
- **平坦时段**：交易员不活跃或处于回撤中
- **垂直下跌**：重大亏损

## 回撤图（水下图）
展示投资组合在任一时点相对峰值下跌了多少。始终为负值或零。

**关键指标：**
- **最大回撤**：投资组合相对峰值跌得最深的幅度
- **恢复时间**：从最严重回撤中恢复所需的时长
- **频率**：回撤发生的频繁程度

**经验法则**：20% 的最大回撤意味着交易员相对最高点亏损了 20%，需要 25% 的收益才能回本。

## 每日收益分布
一张直方图，展示有多少天为正收益、多少天为负收益。

**要关注什么：**
- **对称性**：钟形 = 稳定。右偏 = 偶尔大赚。左偏 = 偶尔大亏。
- **肥尾**：极端日很多 = 高波动
- **窄分布**：大多数日子接近 0% = 低波动、稳定

## 专业提示
1. 对比 7D、30D 和 90D 曲线——短期表现可能与长期大相径庭
2. ROI 较低但回撤较小的交易员，可能更适合跟单（情绪压力更小）
3. 结合胜率与平均持仓时间来看——90% 胜率搭配 1 分钟持仓，可能是机器人
    `.trim(),
      ja: `
# エクイティカーブの読み方

Arena の各トレーダーのプロフィールには、いくつかのチャートが表示されます。読み解き方は次のとおりです：

## エクイティカーブ
時系列で累積 ROI を示すメインのチャートです。健全なエクイティカーブは、落ち込みが小さく **右肩上がり** に傾きます。

**注目すべき点：**
- **緩やかな右肩上がり**：一貫した成績（良い）
- **鋭いスパイク**：少数の取引に偏った利益（リスクあり）
- **横ばいの期間**：トレーダーが非アクティブ、またはドローダウン中
- **垂直的な下落**：大きな損失

## ドローダウンチャート（アンダーウォーターチャート）
ポートフォリオが任意の時点でピークからどれだけ下落しているかを示します。常にゼロまたはマイナスです。

**主要指標：**
- **最大ドローダウン**：ピークからの最も深い下落幅
- **回復時間**：最悪のドローダウンから回復するまでの期間
- **頻度**：ドローダウンが発生する頻度

**目安**：最大ドローダウン 20% は、トレーダーが最高値から 20% 失ったという意味です。回復には 25% の利益が必要です。

## 日次リターン分布
プラスのリターンとマイナスのリターンの日数を示すヒストグラムです。

**注目すべき点：**
- **対称性**：ベル型 = 一貫している。右に歪む = 時折大きく勝つ。左に歪む = 時折大きく負ける。
- **ファットテール**：極端な日が多い = 高ボラティリティ
- **狭い分布**：ほとんどの日が 0% 付近 = 低ボラティリティで安定

## プロのヒント
1. 7D、30D、90D のカーブを比較する——短期の成績は長期と大きく異なることがある
2. ROI は低くてもドローダウンが小さいトレーダーは、コピートレードに向くことがある（精神的な負担が少ない）
3. 勝率と平均保有時間を合わせて確認する——勝率 90% で保有 1 分ならボットの可能性がある
    `.trim(),
      ko: `
# 자산 곡선 읽는 법

Arena의 모든 트레이더 프로필에는 여러 차트가 표시됩니다. 해석 방법은 다음과 같습니다:

## 자산 곡선
시간에 따른 누적 ROI를 보여주는 주요 차트입니다. 건강한 자산 곡선은 하락이 적으면서 **오른쪽 위로** 기울어집니다.

**살펴볼 점:**
- **꾸준한 상승 기울기**: 일관된 성과(좋음)
- **급격한 스파이크**: 소수 거래에 집중된 이익(위험)
- **평평한 구간**: 트레이더가 비활성이거나 드로다운 중
- **수직 하락**: 큰 손실

## 드로다운 차트(언더워터 차트)
포트폴리오가 임의의 시점에 최고점보다 얼마나 하락했는지 보여줍니다. 항상 0 또는 음수입니다.

**핵심 지표:**
- **최대 드로다운**: 최고점 대비 가장 깊은 하락폭
- **회복 시간**: 최악의 드로다운에서 회복하는 데 걸린 기간
- **빈도**: 드로다운이 발생하는 빈도

**경험 법칙**: 최대 드로다운 20%는 트레이더가 최고점에서 20%를 잃었다는 뜻입니다. 회복하려면 25% 수익이 필요합니다.

## 일별 수익 분포
양의 수익 대 음의 수익 날짜 수를 보여주는 히스토그램입니다.

**살펴볼 점:**
- **대칭성**: 종 모양 = 일관됨. 오른쪽으로 치우침 = 가끔 크게 이김. 왼쪽으로 치우침 = 가끔 크게 잃음.
- **팻 테일**: 극단적인 날이 많음 = 높은 변동성
- **좁은 분포**: 대부분의 날이 0% 근처 = 낮은 변동성, 일관됨

## 프로 팁
1. 7D, 30D, 90D 곡선을 비교하세요——단기 성과는 장기와 크게 다를 수 있습니다
2. ROI는 낮지만 드로다운이 작은 트레이더가 카피 트레이딩에 더 나을 수 있습니다(정서적 스트레스가 적음)
3. 승률과 평균 보유 시간을 함께 확인하세요——1분 보유에 승률 90%라면 봇일 수 있습니다
    `.trim(),
    },
  },
  {
    slug: 'arena-pro-features',
    title: {
      en: 'Arena Pro: What You Get with a Subscription',
      zh: 'Arena Pro：订阅能获得什么',
      ja: 'Arena Pro：サブスクリプションで得られるもの',
      ko: 'Arena Pro: 구독으로 얻는 것',
    },
    excerpt: {
      en: 'Detailed overview of Pro features including advanced analytics, trader comparison, rank alerts, and more.',
      zh: '详细介绍 Pro 功能，包括高级分析、交易员对比、排名提醒等等。',
      ja: '高度な分析、トレーダー比較、ランクアラートなど、Pro 機能の詳細な概要。',
      ko: '고급 분석, 트레이더 비교, 순위 알림 등 Pro 기능에 대한 상세 개요.',
    },
    content: {
      en: `
# Arena Pro Features

Arena Pro unlocks powerful tools for serious traders and analysts. Here's what's included:

## Advanced Analytics
- **Score Breakdown**: See exactly how a trader's Arena Score is built — the PnL, ROI, drawdown, Sharpe, and consistency dimensions, plus the confidence multiplier
- **Risk Metrics**: Sharpe ratio, Sortino ratio, Calmar ratio, and profit factor for every trader
- **Market Correlation**: Beta to BTC/ETH and alpha generation metrics

## Trader Comparison
- Compare up to 5 traders side-by-side
- Overlay equity curves on a single chart
- Correlation analysis between traders
- Style compatibility matrix

## Rank Alerts
- Get notified when a followed trader enters or exits the top 100
- Custom threshold alerts (e.g., "Alert me if ROI drops below 50%")
- Delivered via in-app notifications and email

## Advanced Filters
- Filter by trading style (Scalper, Swing, Trend, Position)
- Minimum score, ROI, PnL thresholds
- Maximum drawdown filter
- Win rate range filter

## Pro Badge
- Purple Pro badge on your profile
- Priority in community features
- Access to Pro-only groups

## Pricing
- **Monthly**: $4.99/month
- **Yearly**: $29.99/year (save 50%)
- **Lifetime**: $49.99 one-time payment

[Upgrade to Pro →](/pricing)
    `.trim(),
      zh: `
# Arena Pro 功能

Arena Pro 为严肃的交易员和分析师解锁强大工具。以下是包含的内容：

## 高级分析
- **评分构成**：精确查看一位交易员的 Arena 评分如何构建——PnL、ROI、回撤、夏普和一致性各维度，以及置信度乘数
- **风险指标**：为每位交易员提供夏普比率、索提诺比率、卡玛比率和盈利因子
- **市场相关性**：相对 BTC/ETH 的 Beta 值及 Alpha 生成指标

## 交易员对比
- 最多可并排对比 5 位交易员
- 在同一张图上叠加资金曲线
- 交易员之间的相关性分析
- 风格兼容性矩阵

## 排名提醒
- 当关注的交易员进入或退出前 100 名时收到通知
- 自定义阈值提醒（例如「当 ROI 跌破 50% 时提醒我」）
- 通过应用内通知和电子邮件送达

## 高级筛选
- 按交易风格筛选（剥头皮、波段、趋势、头寸）
- 最低分数、ROI、PnL 阈值
- 最大回撤筛选
- 胜率区间筛选

## Pro 徽章
- 个人资料上的紫色 Pro 徽章
- 社区功能中的优先权
- 可访问仅限 Pro 的群组

## 定价
- **月付**：$4.99/月
- **年付**：$29.99/年（省 50%）
- **终身**：$49.99 一次性付款

[升级到 Pro →](/pricing)
    `.trim(),
      ja: `
# Arena Pro の機能

Arena Pro は、本格的なトレーダーやアナリスト向けの強力なツールを解放します。含まれる内容は次のとおりです：

## 高度な分析
- **スコアの内訳**：トレーダーの Arena スコアがどのように構成されているかを正確に確認——PnL、ROI、ドローダウン、シャープ、一貫性の各指標と、信頼度係数
- **リスク指標**：各トレーダーのシャープレシオ、ソルティノレシオ、カルマーレシオ、損益比
- **市場相関**：BTC/ETH に対するベータと、アルファ生成の指標

## トレーダー比較
- 最大 5 人のトレーダーを並べて比較
- 1 つのチャートにエクイティカーブを重ねて表示
- トレーダー間の相関分析
- スタイル相性マトリクス

## ランクアラート
- フォロー中のトレーダーがトップ 100 に入る／外れるときに通知
- カスタムしきい値アラート（例：「ROI が 50% を下回ったら通知して」）
- アプリ内通知とメールで配信

## 高度なフィルター
- トレードスタイルで絞り込み（スキャルピング、スイング、トレンド、ポジション）
- 最低スコア、ROI、PnL のしきい値
- 最大ドローダウンのフィルター
- 勝率レンジのフィルター

## Pro バッジ
- プロフィールに紫色の Pro バッジ
- コミュニティ機能での優先権
- Pro 限定グループへのアクセス

## 料金
- **月額**：$4.99/月
- **年額**：$29.99/年（50% お得）
- **買い切り**：$49.99 の一度きりの支払い

[Pro にアップグレード →](/pricing)
    `.trim(),
      ko: `
# Arena Pro 기능

Arena Pro는 진지한 트레이더와 분석가를 위한 강력한 도구를 잠금 해제합니다. 포함된 내용은 다음과 같습니다:

## 고급 분석
- **점수 구성**: 트레이더의 Arena 점수가 어떻게 구성되는지 정확히 확인——PnL, ROI, 드로다운, 샤프, 일관성 차원과 신뢰도 배수
- **리스크 지표**: 모든 트레이더에 대한 샤프 지수, 소르티노 지수, 칼마 지수, 손익비
- **시장 상관관계**: BTC/ETH에 대한 베타와 알파 생성 지표

## 트레이더 비교
- 최대 5명의 트레이더를 나란히 비교
- 하나의 차트에 자산 곡선을 겹쳐 표시
- 트레이더 간 상관관계 분석
- 스타일 호환성 매트릭스

## 순위 알림
- 팔로우한 트레이더가 상위 100위에 진입하거나 이탈할 때 알림
- 사용자 지정 임계값 알림(예: "ROI가 50% 아래로 떨어지면 알려줘")
- 앱 내 알림과 이메일로 전달

## 고급 필터
- 트레이딩 스타일로 필터링(스캘핑, 스윙, 트렌드, 포지션)
- 최소 점수, ROI, PnL 임계값
- 최대 드로다운 필터
- 승률 범위 필터

## Pro 배지
- 프로필의 보라색 Pro 배지
- 커뮤니티 기능에서의 우선권
- Pro 전용 그룹 접근

## 요금
- **월간**: $4.99/월
- **연간**: $29.99/년(50% 절약)
- **평생**: $49.99 일회성 결제

[Pro로 업그레이드 →](/pricing)
    `.trim(),
    },
  },
]

export function getArticleBySlug(slug: string): Article | undefined {
  return ARTICLES.find((a) => a.slug === slug)
}
