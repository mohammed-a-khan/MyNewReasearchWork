/** Page objects for ClaimDesk (back office). */
import { screen } from 'eztest/sdk';

export const ClaimDesk = screen('ClaimDesk', {
  search: { css: '#q', label: 'Find claim' },
  searchButton: { role: 'button', name: 'Search' },
  queue: { role: 'table', name: 'Claims queue' },
  approvedAmount: { css: '#approvedAmount', label: 'Approved amount' },
  reason: { css: '#reason', label: 'Decision reason' },
  approve: { role: 'button', name: 'Approve' },
  reject: { role: 'button', name: 'Reject' },
  refer: { role: 'button', name: 'Refer to senior' },
  status: { css: '#status' },
  payout: { css: '#payout' },
  history: { css: '#history' },
  review: (claimId: string) => ({ css: `a[href="/claims/${claimId}"]`, description: `the Review link of ${claimId}` }),
});
