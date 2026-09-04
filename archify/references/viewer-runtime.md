# Viewer Runtime reference

Read this only when the user asks for a reader-facing capability. Ordinary generation does not require implementing or re-documenting these features; they are already in the generated HTML.

## Exploration

- Diagram Guide lists current actions and shortcuts.
- Reading Depth starts at READ at the default 100% scale, reveals FULL detail at 175%, and falls back to MAP only below 100%. Focus, story, route, and semantic interactions reveal their exact facts at any scale.
- Semantic Lens summarizes selected node/relationship kinds without changing authored geometry.
- Intent Trace previews a fine-pointer or keyboard target before committed focus.
- Node Finder searches labels and stable IDs.
- Semantic Passport opens on focus, shows authored upstream/downstream facts, supports a copyable deep link, has an explicit close action, closes on true outside activation and Escape, and never enters canonical export.
- Semantic Radar mirrors the visible viewport and authored graph without becoming a second source of truth.
- Direct Relationship Pin makes a unique compiled relationship operable while preserving the authored line and stable relationship identity. It must fail closed on conflicting source/target/label/ID metadata.
- Route Probe resolves exactly two endpoints over authored directed relationships. It never infers a route from geometry.

## Change Notes (4Crux fork)

Notes mode (`A`, or the NOTES dock button) turns the next click on a node, structural frame (lane, stage, segment, boundary), or relationship into a change request. The reader writes what should change in a small editor; saved notes draw as numbered overlay markers and list in the Change Notes panel. **Copy changes** (panel button or Export → Copy change notes) writes one Markdown report to the clipboard: diagram title and type, then per note the element's stable id, label, kind, authored detail/context, incoming and outgoing relationships, the frame's contained nodes, and the request text, followed by a JSON block for tooling. It is meant to be pasted into an AI assistant that edits the Archify JSON source.

Notes are viewer state only. They persist in this browser's `localStorage` under `archify-change-notes:<digest>`, where the digest covers the diagram type, title, node ids, and relationship keys, so a re-authored topology starts clean. Markers carry `data-annotation-overlay` and are removed from every canonical export; the receipt gate rejects any leftover marker. Notes never rewrite the source, the URL, or another artifact.

## Guided views and story

`meta.views` may define at most five curated chapters using stable node IDs. The Named Chapter Rail, Chapter Delta Preview, Story Beat Navigator, Story Follow Camera, Story Director Strip, Story Horizon, and Shareable Story Moment links all derive from that one authored array; none owns parallel topology or layout.

Story transitions classify only the exact relationship between adjacent authored stops: forward, reverse, multiple, or grouped/no direct link. Never infer a transitive edge, verb, causality, or runtime behavior from proximity, kinds, or story order. Playback is reader-started, bounded, stale-safe, and motion-governed.

## Motion and presentation

`meta.animation: "trace"` enables a finite reader-controlled Live/Still trace. Static is the default. Still, reduced motion, page hiding, print, and canonical export preserve complete static meaning. Presentation Stage changes viewer chrome and framing, never authored geometry. This is not a mobile product feature; narrow layouts get containment only.

## Canonical exports

The export menu can copy/download full-diagram PNG, download JPEG/WebP, download a dual-theme SVG, and record a trace-enabled WebM. Viewer state—Guide, Lens, finder, focus, route, story, camera, radar, presentation, motion ownership, and temporary overlays—must be removed from canonical export.

### Share Card

The optional 1200×630 Share Card PNG is for README, release, social, or launch previews. It uses the current theme and visual preset, contains the complete canonical diagram without cropping, and never claims validation. Copy Share Card reuses the same canonical PNG when clipboard image writes are supported.

### Route Share Card

After a real directed Route Probe resolves, the reader may use **Export → Route Share Card**. It reuses the exact ordered route snapshot and the shared Share Card seam: `format=share-card`, `variant=route`. The isolated clone may use only static `data-share-route-*` decoration. It is download-only, fails closed for stale/unreachable/conflicting routes, and never becomes the canonical artifact.

### Reach Share Card

After a non-empty authored reachability query, the reader may use **Export → Reach Share Card**. It consumes the already resolved upstream/downstream node and edge set without rerunning traversal: `format=share-card`, `variant=reach`. The isolated clone may use only static `data-share-reach-*` decoration. It is download-only. Call it authored reachability—not impact, blast radius, breakage, or runtime causality.

## Truth boundary

Viewer exports are communication assets. They do not replace the checked HTML, the deterministic delivery receipt, or a real visual review. Do not add a hosted service, dependency, schema branch, or mobile product surface for these viewer-only capabilities. The only storage surface is the browser-local Change Notes store described above; it is a reader convenience, never a second source of truth.
