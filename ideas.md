# Reelbox Design Direction

## Theme: Midnight Screening Room
A premium dark cinema interface with a confident editorial feel, built around poster artwork, cinematic crops, and bright lime accents. Probability: 0.08.

## Theme: Neon Video Store
A high-energy streaming storefront with electric cyan and magenta accents, oversized typography, and playful hover states. Probability: 0.07.

## Theme: Quiet Film Journal
A warm, magazine-like catalog with paper tones, serif type, and restrained motion. Probability: 0.06.

## Committed direction: Midnight Screening Room

Reelbox should feel like opening a private screening room: dark graphite backgrounds, soft panel surfaces, crisp white type, and a single acid-lime action color used for selected states, progress, and clear calls to watch. The experience should be calm and fast rather than noisy.

### Design dimensions

- **Movement:** contemporary editorial streaming UI with a cinematic frame and compact catalog density.
- **Core principles:** content first, immediate feedback, low visual noise, high contrast, one clear action per surface.
- **Color philosophy:** near-black graphite for the canvas, charcoal for cards, warm white for readable text, muted slate for metadata, acid lime for focus and primary actions, restrained burgundy for errors.
- **Layout paradigm:** a sticky, compact header; an asymmetric hero with a large visual field; horizontal rails for discovery; dense responsive grids for catalogs; a dedicated dark watch surface.
- **Signature elements:** filmstrip-inspired brand mark, small uppercase section labels, pill-shaped metadata chips, thin lime progress bars, and poster cards that lift gently on hover.
- **Interaction philosophy:** instant navigation feedback, skeletons instead of blank areas, debounced search, clear retry actions, and controls that stay discoverable without overwhelming the content.
- **Animation:** short 160–220ms opacity/translate transitions, no blocking intro animation, respect `prefers-reduced-motion`.
- **Typography:** system sans stack for fast rendering, with strong condensed-like letter spacing on labels and oversized but controlled display headings.
- **Brand essence:** focused, quick, quietly premium.
- **Brand voice:** direct, warm, concise, never overpromising stream availability.
- **Wordmark/logo:** “REELBOX” in compact uppercase with a simple filmstrip mark: three filled frames feeding into a play triangle.
- **Signature brand color:** `#c7ff3d` acid lime.

The logo will be implemented as a flat, high-contrast SVG mark and a square favicon/icon using the same filmstrip/play silhouette. No gradients or visual noise are needed for the brand identity.
