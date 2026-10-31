import { describe, expect, it } from 'vitest';
import type { Row } from './engine';
import { DEFAULT_FINANCE, decodeFinance, encodeFinance, monthlyPayment, simulate, stampDuty } from './finance';

describe('stampDuty (SA general rates)', () => {
  it('matches the RevenueSA schedule at its thresholds', () => {
    expect(stampDuty(12_000)).toBe(120);
    expect(stampDuty(100_000)).toBe(2830);
    expect(stampDuty(300_000)).toBe(11_330);
    expect(stampDuty(500_000)).toBe(21_330);
    expect(stampDuty(1_000_000)).toBe(48_830);
    expect(stampDuty(0)).toBe(0);
  });
});

describe('finance', () => {
  it('computes a principal-and-interest repayment', () => {
    // A$500,000 at 6 % over 30 years ≈ A$2,997.75 per month.
    expect(monthlyPayment(500_000, 0.06, 30)).toBeCloseTo(2997.75, 1);
    expect(monthlyPayment(120_000, 0, 10)).toBeCloseTo(1000, 6);
    expect(monthlyPayment(0, 0.04, 20)).toBe(0);
  });

  it('builds net yield and cash flow step by step', () => {
    const row = { code: 'x', nom: 'x', price_median_house: 500_000, rent_week_house: 500 } as Row;
    const f = { ...DEFAULT_FINANCE, otherCosts: 3000, vacancy: 2, charges: 0.1, holding: 4000 };
    const s = simulate(row, f)!;
    expect(s.totalCost).toBe(500_000 + 21_330 + 3000);
    expect(s.rentYear).toBe(26_000);
    // 26 000 − 1 000 (2 weeks) − 2 500 (10 % of 25 000) − 4 000 = 18 500 per year
    expect(s.netIncome).toBeCloseTo(18_500);
    expect(s.netYield).toBeCloseTo(18_500 / 524_330);
    expect(s.loan).toBeCloseTo(524_330 * 0.8);
    expect(s.cashflowMonth).toBeCloseTo(18_500 / 12 - monthlyPayment(524_330 * 0.8, f.rate, f.years));
  });

  it('needs a price and a rent', () => {
    expect(simulate({ code: 'x', nom: 'x', price_median_house: 700_000, rent_week_house: null }, DEFAULT_FINANCE)).toBeNull();
  });

  it('round-trips assumptions in the share link', () => {
    const f = { ...DEFAULT_FINANCE, rate: 0.055, years: 25 };
    const e = encodeFinance(f);
    expect(e).toBe('rate:0.055,years:25');
    expect(decodeFinance(e)).toEqual(f);
    expect(decodeFinance('rate:abc,bogus:3')).toEqual(DEFAULT_FINANCE);
  });
});
