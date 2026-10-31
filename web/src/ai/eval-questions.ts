// Test questions for the assistant, with the filters a correct plan must contain.
// "expect" lists column:op pairs; extra filters are allowed but reported.

export interface EvalQuestion {
  id: string;
  text: string;
  mode: 'answer' | 'action';
  expect: string[];
  /** Expected web_search routing (default false). */
  web?: boolean;
}

export const QUESTIONS: EvalQuestion[] = [
  { id: 'risks', mode: 'action', text: 'Hide suburbs with more than 1 risk flag', expect: ['risk_count:max'] },
  { id: 'budget', mode: 'answer', text: 'Where can I buy a house under $800k within 15 km of the CBD?', expect: ['price:max', 'cbd_km:max'] },
  { id: 'bushfire', mode: 'answer', text: 'I want a green, hilly suburb with no bushfire risk', expect: ['forest_around_share:min', 'relief_m:min', 'bushfire_med_high_share:max'] },
  { id: 'yield', mode: 'answer', text: 'Which suburbs have a gross yield above 4% and rising rents?', expect: ['gross_yield:min', 'rent_trend_5y:min'] },
  { id: 'safe', mode: 'answer', text: 'Safe, well-off suburbs in Unley or Mitcham', expect: ['crime_burglary:max', 'seifa_decile_sa:min'] },
  { id: 'coast', mode: 'action', text: 'Remove low-lying coastal suburbs', expect: ['low_lying_share:max'] },
  { id: 'schools', mode: 'answer', text: 'What are the best public schools near Norwood?', expect: [], web: true },
];
