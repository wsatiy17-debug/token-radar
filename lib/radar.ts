// The token radar's model: the sealed snapshot in, a ranked board and the dashboard's data out.
//
// The board ranks every protocol that records no token, strongest implied value first. The watchlist
// (40 protocols at or above the $50M floor) is the floor, never the ceiling: the board also carries
// every other rankable pre-token protocol below it, the early rows the radar exists to find.
// Protocols whose token already trades are kept apart in a live view with their market caps.
//
// Implied value is calibrated from the snapshot's own market, never from a hardcoded multiple:
//
//   multiple   = the median market-cap-to-TVL ratio of the live-token protocols in the same
//                category (at least 3 of them), clamped to half-to-double the global median;
//                the global median when the category has too few live tokens.
//   growthMult = (1 + clamp(change_7d, -60, 150) / 100) ** 0.5   (square-root dampening:
//                a hot week lifts the value, but a single week cannot double it)
//   maturity   = 0.7 + 0.3 * (1 - exp(-age_days / 365))          (saturating: a protocol that
//                has run three years with no token scores near the top of the band)
//   implied    = max(1, round(tvl_usd * multiple * growthMult * maturity))
//
// No protocol name is ever special-cased: the same functions score every row, and the calibration
// is recomputed from the snapshot on every run, so the numbers the page shows are the numbers
// the snapshot's own live-token market implies.

/** One protocol entry of the sealed snapshot: exactly the ten fields the input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's shape constants. The multiple itself is calibrated, not set here. */
export interface ModelConstants {
  growth_floor: number;
  growth_cap: number;
  growth_power: number;
  maturity_floor: number;
  maturity_span: number;
  maturity_tau_days: number;
  unknown_age_days: number;
  min_category_samples: number;
  category_clamp_lo: number;
  category_clamp_hi: number;
}

export const MODEL: ModelConstants = {
  growth_floor: -60,
  growth_cap: 150,
  growth_power: 0.5,
  maturity_floor: 0.7,
  maturity_span: 0.3,
  maturity_tau_days: 365,
  unknown_age_days: 180,
  min_category_samples: 3,
  category_clamp_lo: 0.5,
  category_clamp_hi: 2,
};

/** The model's version label, shown on the dashboard. */
export const MODEL_VERSION = 'radar-cal-1';

/** How many live-token protocols the dashboard's live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The calibration the snapshot's own live-token market implies. */
export interface Calibration {
  /** Median market-cap-to-TVL ratio across live-token, non-exchange protocols. */
  global_multiple: number;
  /** Per-category medians, each clamped to half-to-double the global multiple. */
  category_multiples: Record<string, number>;
  /** How many live-token protocols the global median is drawn from. */
  live_samples: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    multiple: number;
    multiple_kind: 'category' | 'global';
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row's compact form for data.js, farm plan included so the page shows board.json's own plan. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  multiple: number;
  multiple_kind: 'category' | 'global';
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const MAX_IMPLIED = 100_000_000_000_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The median of a non-empty list of numbers; 0 when the list is empty. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a release marker (V2, v3, 2.0): a versioned pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/**
 * Whether a pre-token protocol is a wrapped, staked or bridged product of a token that already
 * trades, using the same rule the watchlist itself was built on (RULES.txt §2): its category is
 * Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking or Restaked BTC, or its name
 * carries the whole word "wrapped", "staked" or "staking", or its name begins with an exchange
 * name. WBTC, USDT0 and the exchange bridges are the examples the rules call out: each records
 * no token, yet its value is the value of a token that trades, so ranking one as a token launch
 * would be the board's loudest mistake. This exclusion applies to early rows only: every
 * watchlist protocol is rankable by definition and is always scored.
 */
const WRAPPED_EARLY_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);
const EXCHANGE_PREFIXES: readonly string[] = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_WORD: RegExp = /\b(wrapped|staked|staking)\b/i;

export function isWrappedLike(p: SnapshotProtocol): boolean {
  if (p.category !== null && WRAPPED_EARLY_CATEGORIES.has(p.category)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix));
}

/**
 * Calibrate the value multiple from the snapshot's own live-token market: the median
 * market-cap-to-TVL ratio across live-token protocols, overall and per category. Exchanges are
 * left out: their TVL is custody, not protocol value, and would drag the median down.
 */
export function calibrate(protocols: SnapshotProtocol[], model: ModelConstants = MODEL): Calibration {
  const live = protocols.filter(
    (p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const global = median(live.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const cat = p.category ?? 'Other';
    const list = byCategory.get(cat) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(cat, list);
  }
  const categoryMultiples: Record<string, number> = {};
  for (const [cat, ratios] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ratios.length < model.min_category_samples) continue;
    const m = median(ratios);
    categoryMultiples[cat] = round4(
      Math.min(model.category_clamp_hi * global, Math.max(model.category_clamp_lo * global, m)),
    );
  }
  return { global_multiple: round4(global), category_multiples: categoryMultiples, live_samples: live.length };
}

/** The multiple one protocol gets: its category's calibrated median, else the global median. */
export function multipleFor(p: SnapshotProtocol, cal: Calibration): { multiple: number; kind: 'category' | 'global' } {
  const cat = p.category ?? 'Other';
  const m = cal.category_multiples[cat];
  if (m !== undefined) return { multiple: m, kind: 'category' };
  return { multiple: cal.global_multiple, kind: 'global' };
}

/** The multipliers and the implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  cal: Calibration,
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; multipleKind: 'category' | 'global'; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, kind } = multipleFor(protocol, cal);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const growthMult = Math.pow(1 + growthPct / 100, model.growth_power);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + model.maturity_span * (1 - Math.exp(-Math.max(ageForModel, 0) / model.maturity_tau_days));
  const implied = Math.max(1, Math.min(MAX_IMPLIED, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult)));
  return { implied, multiple, multipleKind: kind, growthPct, growthMult, maturityMult, age };
}

// ---------------------------------------------------------------- farm plans

/** A step as one string: action, then its cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page before you move it.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A second chain when the protocol runs on more than one. */
function secondChainOf(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** A typical gas cost in dollars for one transaction on a chain, from the chain's own fee market. */
function gasUsd(chain: string): number {
  const table: Record<string, number> = {
    Ethereum: 8,
    'BNB Chain': 0.2,
    Polygon: 0.08,
    Arbitrum: 0.4,
    Optimism: 0.35,
    Base: 0.25,
    Avalanche: 0.35,
    Solana: 0.01,
    Sui: 0.01,
    Aptos: 0.01,
    Tron: 0.5,
    Fantom: 0.1,
    Gnosis: 0.05,
    'zkSync Era': 0.3,
    Linea: 0.25,
    Scroll: 0.3,
    Blast: 0.2,
    Mantle: 0.15,
    Mode: 0.1,
    Sei: 0.01,
    Hyperliquid: 0.01,
    Berachain: 0.05,
    Sonic: 0.05,
    Unichain: 0.2,
    Ink: 0.2,
    Abstract: 0.15,
    Cronos: 0.05,
    Kava: 0.05,
    Celo: 0.02,
    Moonbeam: 0.1,
    Aurora: 0.05,
  };
  return table[chain] ?? 1;
}

function money(n: number): string {
  if (n >= 1) return `$${n % 1 === 0 ? n : n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

/** How much capital one farm position needs, from the protocol's own TVL band. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 25_000_000) return 50;
  return 25;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The category's main farming action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow a small amount against it so the wallet shows both sides of the market.`;
  }
  if (c.includes('leveraged farm')) {
    return `Open a $${capital} leveraged farming position on ${name} on ${chain} at the lowest leverage it offers, and keep it open.`;
  }
  if (c.includes('dex')) {
    return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and stake the LP receipt if the app offers it.`;
  }
  if (c.includes('yield aggregator') || c.includes('yield')) {
    return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC through ${name} to ${chain}, then use the bridged funds inside its app instead of bridging straight back.`;
  }
  if (c.includes('liquid staking') || c.includes('liquid restaking') || c.includes('restak') || c.includes('staking pool')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and hold the receipt token it issues.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and place one position on a market that settles within the month.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into a ${name} curated vault on ${chain} and keep the shares through at least one rebalance.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} into ${name}'s basis vault on ${chain} and hold the position through a funding cycle.`;
  }
  if (c.includes('stablecoin') || c.includes('stable')) {
    return `Mint $${capital} of the stable asset through ${name} on ${chain} and hold it in the wallet.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('index')) {
    return `Buy $${capital} of ${name}'s index token on ${chain} and hold it.`;
  }
  if (c.includes('privacy')) {
    return `Deposit $${capital} into ${name}'s shielded pool on ${chain} and keep the note it issues.`;
  }
  if (c.includes('launchpad')) {
    return `Stake $${capital} through ${name} on ${chain} to qualify for its next allocation round.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The weekly repeat action, matched to the category. */
function repeatFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return 'a small supply or borrow';
  if (c.includes('dex') || c.includes('leveraged farm')) return 'a swap or a liquidity top-up';
  if (c.includes('bridge')) return 'one bridge transfer';
  if (c.includes('stak') || c.includes('restak')) return 'a small stake or a restake';
  if (c.includes('perpetual') || c.includes('derivative')) return 'one small trade';
  if (c.includes('prediction')) return 'one market position';
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield') || c.includes('basis') || c.includes('rwa')) {
    return 'a small deposit or a vault rebalance';
  }
  return 'a deposit, a swap or a vote';
}

/** The risk a farmer of this category should check before sizing up, plus a growth caution. */
function riskFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  let risk: string;
  if (c.includes('dex') || c.includes('leveraged farm')) {
    risk = "Impermanent loss cuts both ways: check the pool's 7-day range before adding more, and never farm with money you need back this month";
  } else if (c.includes('lend') || c.includes('cdp')) {
    risk = 'A borrow can be liquidated if the collateral falls: keep the health factor above 2 and set a price alert before you size up';
  } else if (c.includes('bridge')) {
    risk = "Bridged funds sit in the bridge's contracts until you use them: move them into the app promptly and never leave a large balance mid-route";
  } else if (c.includes('stak') || c.includes('restak')) {
    risk = 'Staked assets can be locked or slashed: read the unlock window and the slashing terms before you add more';
  } else if (c.includes('perpetual') || c.includes('derivative')) {
    risk = 'Leverage liquidates fast in a volatile week: keep the position small and the margin well above the maintenance level';
  } else if (c.includes('rwa') || c.includes('basis')) {
    risk = 'The yield depends on off-chain assets or funding rates that can flip: check the latest attestation or funding rate before adding more';
  } else {
    risk = 'Smart contracts fail: check the protocol has a public audit and never deposit more than you can afford to lose';
  }
  const g = p.change_7d;
  if (g !== null && g < -20) {
    risk += `. TVL fell ${Math.abs(g).toFixed(1)}% in the last 7 days, so size this position smaller than usual until the outflow stops`;
  } else if (g !== null && g > 50) {
    risk += `. TVL jumped ${g.toFixed(1)}% in the last 7 days, so expect crowded points and check the rewards page before chasing it`;
  }
  return `${risk}.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age, 7-day growth), never from a
 * hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const second = secondChainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
  const gasEach = money(gas);
  const steps: FarmStep[] = [
    {
      text: `Open ${p.name}'s official app only from the link its own docs publish, never from a search ad or a DM, and farm from a fresh wallet that holds only this position's funds.`,
      cost: 'no fee to check; under $1 of gas to fund the wallet',
      time: '10 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about ${gasEach} of gas`,
      time: '20 minutes to set up',
    },
    {
      text: `Do ${repeatFor(p)} once a week so the wallet shows steady use across snapshots instead of a single deposit.`,
      cost: `about ${gasEach} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity lands in more than one points snapshot; withdrawing early can void a whole season.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: riskFor(p),
      cost: 'nothing to check',
      time: '10 minutes',
    },
  ];
  if (second !== null) {
    steps.push({
      text: `Mirror the position on ${second}: the same action on a second chain doubles the surfaces the protocol can snapshot, and some seasons reward each chain separately.`,
      cost: `another $${capital} of capital and about ${money(gasUsd(second))} of gas`,
      time: '20 minutes',
    });
  } else {
    steps.push({
      text: `Keep a farm log with the wallet address, the dates and every transaction hash, so you can prove the position, repeat it next season or unwind it cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    });
  }
  return steps;
}

// ---------------------------------------------------------------- board

/** The snapshot's protocols by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The live-token protocols, by market cap, for the dashboard's live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The ranked board: every rankable pre-token protocol, watchlist first in coverage, strongest implied value first. */
export function buildBoard(snapshot: Snapshot, cal: Calibration, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, whatever its TVL, except the
  // wrapped, staked and bridged products of tokens that already trade (see isWrappedLike).
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p) && !isWrappedLike(p)) chosen.set(p.slug, p);
  }
  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, cal, model);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watchlist.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      multiple: s.v.multiple,
      multiple_kind: s.v.multipleKind,
      growth_pct: s.v.growthPct,
      growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.multiple,
    multiple_kind: row.model.multiple_kind,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const cal = calibrate(snapshot.protocols, model);
  const board = buildBoard(snapshot, cal, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim(),
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration: cal,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------- input and checks

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > MAX_IMPLIED) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
