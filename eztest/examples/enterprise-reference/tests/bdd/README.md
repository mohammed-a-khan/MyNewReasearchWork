# BDD features (placeholder)

This folder is reserved for Gherkin `.feature` files for the Larkspur claims domain.

Native `.feature` execution in EZTest is being built separately; the features for this
reference suite will be added here once it lands. Until then, nothing in this folder is run.

Planned features, mapped to the journeys that already cover the same behaviour:

| Feature | Behaviour | Covered today by |
|---|---|---|
| `quote.feature` | Premium = base x region x loading - no-claims discount, + 12% tax, minimum 150 | `journeys/portal/quote-home-premium.ez`, `quote-matrix-*.ez` |
| `first-notice-of-loss.feature` | File a claim with documents and the declaration; late notification after 30 days | `journeys/portal/claim-submit-ui-to-api-db.ez`, `dates-on-fake-clock.ez` |
| `claim-decision.feature` | Approve within authority, refer above it, reject with confirmation | `journeys/backoffice/*.ez` |
| `settlement.feature` | E-mailed link and code, IBAN, nightly payment file, statement | `journeys/e2e/claim-lifecycle-cross-app.ez` |

The step vocabulary should reuse the existing building blocks (the element repository in
`elements/`, the code steps in `steps/`, the sub-journeys in `journeys/lib/` and the
`@larkspur/eztest-steps` plugin) rather than introduce a second set of page objects.
