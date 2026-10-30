# Release preparation validation

Verified October 22, 2026. This checkout contains uncommitted local preparation changes. Nothing was pushed, made public, deployed or submitted by this release-preparation task.

## Current checks

- Full `npm test`: **78/78 passed**, 0 failed, 0 skipped; completed 2026-10-22T09:40:56.933236+00:00.
- After the final research/history changes, citation-filter/legacy-record fixture unit checks passed **17/17**. The subsequent Tavily API/browser checks passed **2/2**, 0 failed, 0 skipped; completed 2026-10-22T10:22:14.857072+00:00. These overlap the full suite; do not sum them as unique tests. `work/release-tavily-filter-test-receipt.json` records the current unit-checked hashes. No unchanged product suite was rerun for that focused patch. Passing local fixtures does not establish useful or semantically supported live model output.
- The full-suite npm pretest syntax check covered **33 JavaScript files**; the final focused run repeated the syntax check over the current sources.


- Runtime: Node v22.14.0; pinned dependencies installed through `npm ci --ignore-scripts --no-audit --no-fund`. Browser tests used the installed Playwright Chromium through the documented executable override. Browser launch required host execution permission on this macOS environment.
- Tests exercised this standalone server, own-product journey, retained receipt/integrity checks, strict model preflight, free-usage gates, Deepgram request/output validation and Tavily source-selection/cited-checklist workflows. Research browser checks ran at 1440×1080 and 390×844, including keyboard consent/selection, reduced motion, injection text and fixture disclosure.
- Provider credentials and free-usage environment settings were removed from the test process. Sponsor transport tests used injected fixtures. **These tests made no live sponsor inference, narration, search, Sandbox or Cloud-job calls.** They cannot establish account access, free balances or live model quality.
- The narration CLI dry run completed without network traffic; `demo/narration-plan.json` preserves the script hash and character count. The parent task generated the accompanying Deepgram Aura-2 Thalia audio on October 22. The copied script and audio hashes match its live generation receipt. `demo/narration-generation.json` records its **90.216 second afinfo estimate**. This release-preparation task made no new narration request. Listening review, content accuracy against final footage and final video measurement remain pending.
- `.env` and account-usage ledgers were not copied into this checkout. The relevant environment settings remain blank/default-deny in `.env.example`. `git check-ignore` confirmed `.env`, `work/free-usage/` and `node_modules/` are excluded. The allowlisted current-source/document scan reviewed 58 text files, including new untracked sources; only explicitly reviewed synthetic test credentials matched. See `SECRET-SCAN.md` for redacted locations and exclusions. Known binary media were hashed but not text-scanned; Git history and unknown credential formats were not checked. The standard scanner's binary-omission verdict remains incomplete.
- `git diff --check` passed. Existing product-specific evidence captures, local request retry protections, one-product routes and repository license were preserved.

## Exact local sources

Base Git commit: `9c63d1c851d1466780d86418f5a2112118f96fe8`. Local changes have no commit SHA because committing was not authorized.

`RELEASE-MANIFEST.json` records SHA-256 hashes of current code, tests, public assets, package lock, documentation and demo sources. Manifest SHA-256: `2a3ca07c1c2e206f489179de8fd2272023df3bf0f2fb2add64c5deeb9c3d91e6`. It excludes the manifest and this report to avoid circular hashes, and excludes private runtime/dependency directories. The base commit plus this manifest identifies the checked local files without implying a published release.

Detailed logs remain local under `work/release-full-tests.log`, `work/release-test-receipt.json`, `work/release-followup-tests.log` and `work/release-followup-test-receipt.json`; the follow-up receipt also records hashes of the checked JavaScript sources and test files. Research screenshots are under `work/release-research-screenshots/`. These paths are ignored and are not automatically published.

## Remaining external gates

Actual sponsor proof, authorized public repository/test-build access, final video/audio review and upload, entrant feedback/declarations, and final submission are separate gates in `demo/release-checklist.md`. Historical screenshots and the older `VALIDATION.md` describe the prior extraction and must not be substituted for this test run or live sponsor evidence. Keep private records and credentials out of any later authorized publication.
