// Links to listing sites, built by the app from the suburb's name and postcode
// (never written by the AI model, which tends to invent URL formats).
//
// Formats written from known public URLs, not from site documentation:
//   realestate.com.au  /buy/property-house-in-<suburb>,+sa+<postcode>/list-1
//   domain.com.au      /sale/<suburb>-sa-<postcode>/house/
// Check one link by hand if a site changes its format.

import type { Row } from './engine';

export interface AdLink {
  label: string;
  url: string;
}

export const firstPostcode = (row: Row): string | null =>
  typeof row.postcodes === 'string' && row.postcodes ? row.postcodes.split(' ')[0] : null;

export function adLinks(row: Row): AdLink[] {
  const pc = firstPostcode(row);
  if (!pc) return [];
  const name = String(row.nom).toLowerCase();
  const rea = `${encodeURIComponent(name).replace(/%20/g, '+')},+sa+${pc}`;
  const dom = `${name.replace(/[^a-z0-9]+/g, '-')}-sa-${pc}`;
  return [
    { label: 'Houses for sale (realestate.com.au)', url: `https://www.realestate.com.au/buy/property-house-in-${rea}/list-1` },
    { label: 'Houses for rent (realestate.com.au)', url: `https://www.realestate.com.au/rent/property-house-in-${rea}/list-1` },
    { label: 'Houses for sale (Domain)', url: `https://www.domain.com.au/sale/${dom}/house/` },
    { label: 'Houses for rent (Domain)', url: `https://www.domain.com.au/rent/${dom}/house/` },
  ];
}
