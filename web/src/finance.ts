// Rental investment simulation per suburb: purchase cost, net yield and monthly
// cash flow for the median house, under the user's financing assumptions.
//
// Everything is an estimate built from suburb medians; the side panel shows each
// step so the user can check the arithmetic.

import type { Row } from './engine';

export interface Finance {
  /** Deposit as a share of the total cost (0..1). */
  deposit: number;
  /** Loan interest rate per year (0.06 = 6 %). */
  rate: number;
  /** Loan term in years. */
  years: number;
  /** Other purchase costs, A$: transfer and mortgage registration, conveyancing, inspections. */
  otherCosts: number;
  /** Property management, letting fees and maintenance, as a share of the rent. */
  charges: number;
  /** Weeks per year without a tenant. */
  vacancy: number;
  /** Yearly holding costs, A$: council rates, emergency services levy, water supply, land tax, insurance. */
  holding: number;
}

export const DEFAULT_FINANCE: Finance = {
  deposit: 0.2,
  rate: 0.06,
  years: 30,
  otherCosts: 5000,
  charges: 0.12,
  vacancy: 2,
  holding: 5000,
};

/**
 * South Australian stamp duty on a transfer of land, general rates (RevenueSA):
 * no first-home or off-the-plan concession, no foreign-ownership surcharge.
 */
const DUTY: [number, number, number][] = [
  // [threshold, duty at threshold, marginal rate above it]
  [500000, 21330, 0.055],
  [300000, 11330, 0.05],
  [250000, 8955, 0.0475],
  [200000, 6830, 0.0425],
  [100000, 2830, 0.04],
  [50000, 1080, 0.035],
  [30000, 480, 0.03],
  [12000, 120, 0.02],
  [0, 0, 0.01],
];

export function stampDuty(price: number): number {
  if (!(price > 0)) return 0;
  const [t, base, rate] = DUTY.find(([th]) => price > th) ?? DUTY[DUTY.length - 1];
  return Math.round(base + (price - t) * rate);
}

export interface Simulation {
  price: number;
  stampDuty: number;
  otherCosts: number;
  totalCost: number;
  rentYear: number;
  vacancyLoss: number;
  charges: number;
  holding: number;
  netIncome: number;
  grossYield: number;
  netYield: number;
  loan: number;
  monthlyPayment: number;
  cashflowMonth: number;
}

/** Monthly repayment of a principal-and-interest loan. */
export function monthlyPayment(principal: number, rate: number, years: number): number {
  const n = years * 12;
  const r = rate / 12;
  if (principal <= 0) return 0;
  if (r === 0) return principal / n;
  return (principal * r) / (1 - (1 + r) ** -n);
}

export function simulate(row: Row, f: Finance): Simulation | null {
  const price = row.price_median_house;
  const week = row.rent_week_house;
  if (typeof price !== 'number' || typeof week !== 'number') return null;
  const duty = stampDuty(price);
  const totalCost = price + duty + f.otherCosts;
  const rentYear = week * 52;
  const vacancyLoss = week * f.vacancy;
  const charges = (rentYear - vacancyLoss) * f.charges;
  const netIncome = rentYear - vacancyLoss - charges - f.holding;
  const loan = totalCost * (1 - f.deposit);
  const mp = monthlyPayment(loan, f.rate, f.years);
  return {
    price, stampDuty: duty, otherCosts: f.otherCosts, totalCost, rentYear, vacancyLoss, charges, holding: f.holding, netIncome,
    grossYield: rentYear / price, netYield: netIncome / totalCost, loan, monthlyPayment: mp, cashflowMonth: netIncome / 12 - mp,
  };
}

/** Adds purchase_price, net_yield and cashflow_month columns. */
export function withFinance(rows: Row[], f: Finance): Row[] {
  return rows.map((r) => {
    const s = simulate(r, f);
    return {
      ...r,
      purchase_price: s ? Math.round(s.totalCost) : null,
      net_yield: s ? s.netYield : null,
      cashflow_month: s ? Math.round(s.cashflowMonth) : null,
    };
  });
}

/** Finance assumptions in the share link: only values that differ from the defaults. */
export function encodeFinance(f: Finance): string {
  const keys = Object.keys(DEFAULT_FINANCE) as (keyof Finance)[];
  return keys.filter((k) => f[k] !== DEFAULT_FINANCE[k]).map((k) => `${k}:${f[k]}`).join(',');
}

export function decodeFinance(s: string | null): Finance {
  const f = { ...DEFAULT_FINANCE };
  if (!s) return f;
  for (const part of s.split(',')) {
    const [k, v] = part.split(':');
    if (k in DEFAULT_FINANCE && Number.isFinite(Number(v))) (f as unknown as Record<string, number>)[k] = Number(v);
  }
  return f;
}
