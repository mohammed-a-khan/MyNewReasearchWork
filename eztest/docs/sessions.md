# Journeys from captured user sessions

EZTest turns how people actually use an app into candidate `.ez` journeys, ranked by how often each path is taken, and shows which of those paths your existing journeys already cover. It is deterministic — no AI turns a session into a test.

```
eztest sessions import captures/ --out journeys/captured --against journeys
eztest sessions snippet --allow coupon,promoCode --endpoint https://collector.test/ez
```

## Inputs

Three formats are read and normalised to the same model (navigate, click, input, select, submit, assert, api):

- **EZTest capture files** — what the capture snippet records (richest: it already has element descriptors).
- **HAR** — navigations from top-level document responses, API calls from XHR/fetch entries. Works with no DOM.
- **rrweb-style event JSON** — the full snapshot builds a node map; incremental click and input events resolve to their element.

## The capture snippet (opt-in, privacy-safe)

`eztest sessions snippet` prints a small script to embed in a **test or staging** environment. It is off until it opts in (`window.__ezCapture.start()`, or `data-eztest-capture` on `<html>`, or `--autostart`).

- It records **which** field was used, never the keystrokes, unless the field's name/id/testid/label is on the `--allow` list — and allow-listed values are **masked to their shape** (`4821` -> `####`, `ada` -> `xxx`) before they are stored.
- Password and hidden fields are never recorded.
- Events are buffered (surviving navigations via `sessionStorage`) and handed to a `--endpoint` with `navigator.sendBeacon`, or read with `window.__ezCapture.flush()`.

## Clustering, generation and the coverage gap

- **Cluster** sessions by their interaction-path signature (navigations + actions, generalising numeric/id URL segments); each cluster is ranked by how many sessions follow it.
- **Generate** one `.ez` journey per cluster, most frequent first, with assertions (URL/title checks after navigations). Allow-listed masked values become a `Variables:` placeholder (`REPLACE_ME`) to fill before the journey runs; everything else is concrete.
- **Coverage gap** (`--against <journeysDir>`): each cluster is matched to the closest existing journey by longest-common-subsequence path overlap. Paths with no match at or above the threshold are reported as gaps, ranked by frequency, so you see the common journeys you have not written yet.

A `sessions-report.json` is written next to the generated journeys with the counts, clusters, generated journeys, the coverage gap and anything skipped.

Exported from `eztest/sessions` (`parseSession`, `clusterSessions`, `generateJourneys`, `coverageGap`, `captureSnippet`).
