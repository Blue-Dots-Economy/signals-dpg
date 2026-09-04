# Browser-QA findings — #644 / #645 / #646 epic (2026-09-04)

Reported by the user against the local stack on branch
`feat/644-list-view-sort-filters` (PR #665). Numbered for tracking; "root"
records the cause where it was traced before implementation began.

## Domain control

**Q1 — Collapse the domain control when only one domain is selectable.**
A signed-in seeker in a network whose interaction matrix has no seeker→seeker
edge still sees a `Seeker` button (disabled) beside `Provider`. When exactly
one domain is selectable, render no control at all — just state the domain
("Showing Providers"). Applies to list **and** map. Images 26, 27.

**Q7 — Facet groups do not follow the selected domain.** The Filters panel
appears to show the same field set whichever domain is picked; it should show
seeker fields for Seeker and provider fields for Provider. Needs empirical
confirmation per view — `filterFieldDomains` (home-page.tsx:946) keys off
`selectedDomain`, but on the **map** the toolbar writes `mapSelectedDomains`
via `handleMapDomainsChange` and never touches `selectedDomain`, so the panel
can be scoped to a stale domain there. Images 29, 31.

## Sort

**Q2 — Sort dropdown checkmark disagrees with the trigger.** The menu shows
"Relevance to your profile" ticked while the trigger reads "Newest". Cause is
correct-but-unexplained: signals-search is down locally, the server degrades
relevance → newest and reports it in `meta.sort_applied`; `SortSelect` labels
the trigger from `applied` but still marks `value` as checked. When relevance
is genuinely unavailable, drop the option from the menu entirely rather than
offer an order the server will not honour. Image 27.

**Q3 — "Newest" must name its basis.** Nothing tells the user the "6 days ago"
age comes from `items.created_at`. Label/help text should say so.

**Q11 — `nearest` does not reorder.** Reproduced logged in and logged out.
With "My profile" as the centre the order is unchanged from newest (image 37);
with "Current location" it *does* change (image 38). Suggests the ordering
centre is absent for the profile source while `nearestAvailable` still enables
the option — `BrowseToolbar` gates on `browseCoords`, the request builder gates
on `userLocation` (use-infinite-browse-items.ts:145). Needs network-tab
confirmation of whether `ordering_latitude/longitude` are on the wire.
Images 36, 37, 38.

## Applied-filter chips

**Q5 — Chips print raw schema keys.** `workExperience`,
`workExperienceYearsConditional`, `natureOfJobsInterestedIn`,
`collegeQualification`, `candidateExperienceType` … The Filters panel already
resolves proper titles ("Work Experience", "Years of Work Experience"), so the
chip bar must reuse the same label source. Images 29, 30.

**Q8 — Clear-all does not persist.** Apply a facet → Clear all (clears) →
reload → the facet is back. Root: `useAppliedFilterChips` is wired with
`setFieldFilters: setMapSelectedFields` (home-page.tsx:1466) — the raw state
setter, not `handleMapFieldsChange`, which is what strips the `?f_*` query
params. State clears, URL does not, and the URL re-seeds on reload. Chip
removal has the same defect. Images 33, 34, 35.

**Q9 — Filter count includes the domain.** One facet chip shows a badge of 2.
Root: `activeCount = selectedDomains.length + enumActiveCount`
(browse-filters-panel.tsx:160). Domain is no longer a panel facet, so it must
not be counted. Image 35.

## Filtering correctness

**Q6 — Applied facets do not match returned items.** Map with
`gender: Don't want to share` + `workExperienceYearsConditional: 15+ Years` +
`workExperience: Returning after a break` returns a provider card whose
Work Experience (Years) is "1 Year" (image 31). A `candidateExperienceType:
Returning after a break` filter returns a seeker whose Work Experience is
"Fresher" (image 32). Note both cases mix seeker-schema and provider-schema
field keys across a multi-domain selection, which is likely entangled with Q7.

## Layout

**Q10 — Sidebar/toolbar divider mismatch may persist.** Fixed at
`components/ui/sidebar.tsx` (commit b3fbab4f) and verified logged out
(separator 8→247px inside a 256px sidebar). User's screenshots may predate the
commit, and the logged-in state (a profile in the sidebar) was not re-measured.
Re-verify logged in.

## Open questions answered separately

- Q4 — provenance of the Area radius ladder (5/10/25/50 km).
- Q12 — whether facets apply on the map given `/markers` returns coordinates.
