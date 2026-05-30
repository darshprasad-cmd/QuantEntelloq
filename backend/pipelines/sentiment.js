/**
 * Lightweight, dependency-free sentiment classifier.
 *
 * Used as a fast fallback when the AI rewrite doesn't include sentiment data
 * (or as a sanity check on what the AI returned). Not as accurate as a
 * transformer, but zero-cost and good enough for ranking.
 *
 * Lexicon curated for financial news (positive/negative weighted by domain).
 */

const POSITIVE = {
  // momentum
  surge: 2, surges: 2, surged: 2, soar: 2, soared: 2, jump: 1.5, jumps: 1.5, jumped: 1.5,
  rally: 2, rallied: 2, rallies: 2, climb: 1.2, climbs: 1.2, climbed: 1.2, gain: 1.2, gains: 1.2,
  rise: 1, rises: 1, rose: 1, advance: 1, advances: 1, advanced: 1, surge: 2,
  // outperformance
  beat: 1.5, beats: 1.5, exceeded: 1.5, exceeds: 1.5, outperform: 2, outperforms: 2, outperformed: 2,
  topped: 1.5, surpassed: 1.5,
  // positive labels
  record: 1.2, all_time_high: 2.5, breakthrough: 2, milestone: 1.5,
  upgrade: 2, upgraded: 2, upgrades: 2, bullish: 2, optimistic: 1.5, optimism: 1.5,
  strong: 1, strongest: 1.5, robust: 1.5, accelerating: 1.5,
  approval: 1.5, approved: 1.5, win: 1.5, wins: 1.5, won: 1.5,
  expansion: 1.2, growth: 1, profitable: 1.5, profit: 1, profits: 1,
  raises: 1.2, raised: 1.2, lifts: 1.2, lifted: 1.2,
  // M&A
  acquires: 1.5, acquired: 1.5, acquisition: 1.2, merger: 0.8, partnership: 1, deal: 0.8,
  // monetary
  cut: 1.0, cuts: 1.0, // (rate cuts read positive for risk assets)
  dovish: 1.5, stimulus: 1.5,
};

const NEGATIVE = {
  // momentum
  plunge: 2.5, plunged: 2.5, plunges: 2.5, slump: 2, slumped: 2, slumps: 2,
  tumble: 2, tumbled: 2, tumbles: 2, plummet: 2.5, plummeted: 2.5, sink: 1.5,
  drop: 1.2, drops: 1.2, dropped: 1.2, fall: 1, falls: 1, fell: 1,
  decline: 1, declined: 1, declines: 1, slip: 1, slipped: 1, slides: 1.2, slid: 1.2,
  // weakness
  miss: 1.5, missed: 1.5, misses: 1.5, disappoint: 1.5, disappointing: 1.5, disappointed: 1.5,
  weak: 1.2, weakest: 1.5, weakening: 1.5, sluggish: 1.5,
  // labels
  downgrade: 2, downgraded: 2, downgrades: 2, bearish: 2, pessimistic: 1.5,
  recession: 2.5, layoffs: 2, layoff: 2, fired: 1.5, fires: 1.5,
  loss: 1.5, losses: 1.5, lost: 1, deficit: 1.5,
  // risk
  warns: 1.5, warned: 1.5, warning: 1.5, risk: 0.8, risks: 0.8, crisis: 2.5,
  investigation: 1.5, fraud: 2.5, lawsuit: 2, sued: 1.5, fine: 1.5, fined: 1.5,
  bankruptcy: 3, bankrupt: 3, default: 2.5, defaulted: 2.5,
  // macro
  hike: 1.0, hikes: 1.0, hiked: 1.0, // rate hikes negative for risk assets
  hawkish: 1.5, tightening: 1.2, inflation: 1.0,
  // trade
  tariff: 1.2, tariffs: 1.2, sanction: 1.5, sanctions: 1.5,
};

const NEGATORS = new Set(['not', 'no', "n't", 'never', 'without', 'lacking']);
const INTENSIFIERS = { very: 1.5, extremely: 2, massively: 2, slightly: 0.5, barely: 0.5 };

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'_\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
}

/**
 * Returns: { sentiment: 'bullish'|'bearish'|'neutral', score: -1..1, confidence: 0..1 }
 */
export function extractSentiment(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return { sentiment: 'neutral', score: 0, confidence: 0 };

  let totalPos = 0;
  let totalNeg = 0;
  let hits = 0;

  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    const next = tokens[i + 1];
    const compound = next ? `${word}_${next}` : null;

    let baseWeight = 0;
    let sign = 0;

    if (compound && POSITIVE[compound] != null) {
      baseWeight = POSITIVE[compound]; sign = 1; i++;
    } else if (compound && NEGATIVE[compound] != null) {
      baseWeight = NEGATIVE[compound]; sign = -1; i++;
    } else if (POSITIVE[word] != null) {
      baseWeight = POSITIVE[word]; sign = 1;
    } else if (NEGATIVE[word] != null) {
      baseWeight = NEGATIVE[word]; sign = -1;
    } else {
      continue;
    }

    // Negation check (look back 2 words)
    if (NEGATORS.has(tokens[i - 1]) || NEGATORS.has(tokens[i - 2])) {
      sign = -sign;
    }
    // Intensifier check
    const intensify = INTENSIFIERS[tokens[i - 1]] ?? 1;
    const weight = baseWeight * intensify;

    if (sign > 0) totalPos += weight;
    else totalNeg += weight;
    hits++;
  }

  const net = totalPos - totalNeg;
  const magnitude = totalPos + totalNeg;
  const score = magnitude > 0 ? net / Math.max(magnitude, 4) : 0;
  const confidence = Math.min(1, hits / 6);

  let sentiment = 'neutral';
  if (score > 0.15) sentiment = 'bullish';
  else if (score < -0.15) sentiment = 'bearish';

  return {
    sentiment,
    score: +score.toFixed(3),
    confidence: +confidence.toFixed(3),
  };
}

/** Extract tickers like $AAPL or AAPL in CAPS contexts. Cheap heuristic. */
export function extractTickers(text) {
  if (!text) return [];
  const out = new Set();
  for (const m of text.matchAll(/\$([A-Z]{1,5}(?:\.[A-Z])?)/g)) out.add(m[1]);
  // Bare upper-case 2-5 letter words preceded by ticker-ish context
  for (const m of text.matchAll(/\b(?:ticker|shares of|stock of)\s+([A-Z]{1,5})\b/g)) out.add(m[1]);
  return [...out];
}
