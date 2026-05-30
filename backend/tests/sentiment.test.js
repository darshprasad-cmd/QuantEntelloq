/**
 * Sentiment classifier — pure-function tests, no DB needed.
 */

import { describe, it, expect } from 'vitest';
import { extractSentiment, extractTickers } from '../pipelines/sentiment.js';

describe('extractSentiment', () => {
  it('returns neutral for empty input', () => {
    expect(extractSentiment('').sentiment).toBe('neutral');
    expect(extractSentiment(null).sentiment).toBe('neutral');
  });

  it('detects bullish wording', () => {
    const r = extractSentiment('Apple surged on a record quarter, beating analyst estimates');
    expect(r.sentiment).toBe('bullish');
    expect(r.score).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('detects bearish wording', () => {
    const r = extractSentiment('NVIDIA plunged after a disappointing forecast and downgrade');
    expect(r.sentiment).toBe('bearish');
    expect(r.score).toBeLessThan(0);
  });

  it('respects negation', () => {
    const a = extractSentiment('Earnings did not disappoint');
    const b = extractSentiment('Earnings disappoint');
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('treats unrelated text as neutral', () => {
    const r = extractSentiment('A new restaurant opened on the corner of Main and Elm');
    expect(r.sentiment).toBe('neutral');
  });
});

describe('extractTickers', () => {
  it('finds $-prefixed tickers', () => {
    expect(extractTickers('$AAPL and $NVDA rallied today')).toEqual(['AAPL', 'NVDA']);
  });

  it('finds tickers from ticker-of phrasing', () => {
    expect(extractTickers('shares of TSLA jumped 5%')).toContain('TSLA');
  });

  it('returns [] for empty', () => {
    expect(extractTickers('')).toEqual([]);
    expect(extractTickers(null)).toEqual([]);
  });
});
