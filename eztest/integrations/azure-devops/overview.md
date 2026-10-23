# EZTest for Azure Pipelines

The **EZTest** task runs EZTest journeys in a pipeline and:

- publishes the results to the pipeline's Tests tab and, optionally, to Azure Test Plans (step results, iterations, screenshots, traces, the signed evidence pack, healed steps, build links, flaky marking, bugs linked to test cases and requirements);
- attaches the run (report and evidence) as a pipeline artifact and adds an **EZTest** tab to the run with the readiness decision, the gates, the failures with their journey line and the heals awaiting review;
- posts the **EZTest: GO / NO_GO** status and one summary comment to the pull request, updated in place on re-runs;
- enforces the release readiness gate: NO_GO fails the stage, GO_WITH_RISKS warns (both configurable).

Authentication uses the job's own access token (`System.AccessToken`), a service principal or workload identity federation; no PAT is needed.

See the EZTest documentation (`docs/azure-devops.md`) for the YAML templates and the multi-stage example.
