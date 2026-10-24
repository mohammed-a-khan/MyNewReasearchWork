/** Page objects for MyCover (customer portal), shared by the code journeys and code steps. */
import { screen } from 'eztest/sdk';

export const Nav = screen('Nav', {
  home: { role: 'link', name: 'Home' },
  quote: { role: 'link', name: 'Get a quote' },
  newClaim: { role: 'link', name: 'Make a claim' },
  claims: { role: 'link', name: 'My claims' },
});

export const QuoteForm = screen('QuoteForm', {
  product: { label: 'Product', css: '#product' },
  sumInsured: { label: 'Sum insured (GBP)', css: '#sumInsured' },
  region: { label: 'Region', css: '#region' },
  riskAge: { css: '#riskAge', description: 'the risk age field (property age or driver age)' },
  noClaims: { label: 'No-claims years', css: '#noClaimsYears' },
  calculate: { role: 'button', name: 'Calculate premium' },
  ref: 'testid=quote-ref',
  total: 'testid=total-premium',
  tax: 'testid=tax',
  net: 'testid=net-premium',
});

/** Same ids as elements/claim-form.yaml: the repository's locators and heals apply here too. */
export const ClaimForm = screen('ClaimForm', {
  policy: { css: '#policyId', label: 'Policy' },
  claimType: { css: '#type', label: 'Claim type' },
  incidentDate: { css: '#incidentDate', label: 'Incident date' },
  amount: { css: '#amountClaimed', label: 'Amount claimed (GBP)' },
  description: { css: '#description', description: 'the "What happened?" field' },
  submit: { role: 'button', name: 'Submit claim', css: '#submit-claim' },
});

export const ClaimPage = screen('ClaimPage', {
  heading: 'css=h1',
  status: 'testid=claim-status',
  approved: 'testid=claim-approved',
  payout: 'testid=claim-payout',
  statement: { role: 'link', name: 'Download statement' },
});
