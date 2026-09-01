# 用量详情 · Design QA

## 对照基准

- Source visual truth: `/var/folders/gf/cpfmvlwn5v31rp_7tdnlr1140000gn/T/TemporaryItems/NSIRD_screencaptureui_JSHk7e/截屏2026-09-01 12.58.40.png`
- Implementation screenshot: `/tmp/keepseek-usage-preview/implementation-pass4.png`
- Combined comparison evidence: `/tmp/keepseek-usage-preview/comparison-pass4.png`
- Source pixels: 423 × 908
- Implementation pixels: 423 × 895
- CSS viewport: 423 × 895; device scale factor 1
- Normalization: source was displayed at 423 × 895 with `object-fit: cover`, cropping 13 px of non-critical bottom edge so the two states could be judged at the same 1:1 width and viewport height.
- State: light VS Code-compatible theme; fixed session scope; source analysis; two source/model groups; context usage 14%; compression threshold 80%.

## Findings

- No actionable P0/P1/P2 mismatch remains.
- The persistent close action is an intentional host-modal constraint. It occupies the right side of the compact top bar where the Reasonix reference uses a page-level utility icon, without changing the content hierarchy.
- Numeric and explanatory copy intentionally follows KeepSeek's actual accounting semantics. In particular, request context, output reserve, physical remaining, Provider pricing, and cache attribution are not replaced with Reasonix-only metrics.

## Required fidelity surfaces

- Fonts and typography: native VS Code/system font stack, weights, numeric emphasis, small-label hierarchy, line height, wrapping, and tabular numerals were checked at 1:1. The resulting density is visually equivalent to the reference.
- Spacing and layout rhythm: card order, section gaps, 2-column session metric grid, three-column budget/analysis grids, radii, dividers, and compact top navigation match the reference structure. A 360 × 800 responsive check reported no horizontal overflow.
- Colors and visual tokens: semantic green, orange context progress, neutral panels, borders, and muted labels use VS Code theme tokens with accessible focus states. No fixed light-only surface is required by the production implementation.
- Image quality and assets: the target page contains no content imagery that needs reproduction. No replacement raster, custom SVG, emoji, or decorative asset was introduced for this screen.
- Copy and content: section labels and controls mirror the reference while preserving KeepSeek's real data meanings. Fee and cache explanations remain in the detail page, not the tooltip.
- Interaction and accessibility: the page has one unambiguous session scope; source/type controls work; source cards and subagent details expand; the dialog closes by button or Escape; focus is restored; 100% main-session attribution shows only the session total and does not repeat “主会话侧”. A clean browser run produced no console errors.

## Focused-region evidence

No separate crop was necessary: both 423 px-wide screens appear side by side at native 1:1 scale in the combined comparison, and the context, session metrics, source-share legend, and both model cards are readable without scaling.

## Comparison history

1. Pass 1 — blocked by P2 vertical-density drift. The modal title plus a second toolbar consumed substantially more height than the Reasonix navigation, clipping the second source card. Fixed by integrating the overview/scope controls into one compact top bar and moving the accessible dialog title off-screen.
2. Pass 2 — blocked by P2 grouping drift. The green context-status surface incorrectly contained the neutral budget and cache explanation; persistent explanation rows also pushed analysis content below the fold. Fixed by separating the status and budget surfaces, showing cache attribution only when a reason exists, keeping fee explanation in expandable source details, adding `<1%` shares, and matching the “总计” label.
3. Pass 3 — passed. The final 423 × 895 comparison has the same information order, component proportions, card rhythm, metric grid, analysis controls, share bar, and visible two-source breakdown as the reference. Remaining differences are intentional product constraints or live-data semantics.
4. Post-QA interaction simplification — retained pass. The redundant session/turn selector was removed, the page was fixed to session totals, and the top label was changed from “概览” to “用量详情”. The final 423 × 895 capture remains free of overlap or horizontal overflow.

## Final result

final result: passed
