---
version: alpha
name: open-tag-design-system
description: The warm-editorial design system used across open-tag's web surfaces. The base canvas is off-white (`#f5f5f5`) holding warm near-black ink (`#292524`); visual energy comes from soft pastel atmospheric gradient orbs (mint → peach → lavender → sky → rose) — the only deliberate "color" moments. Display runs EB Garamond Light at weight 300 as the editorial serif accent; Inter carries body, navigation, captions, and buttons. CTAs are subtle: a near-black ink pill is the primary, a transparent outline is the secondary. The system trusts atmospheric composition and modest type weights to carry all brand work — no neon accents, no saturated CTA color, no dark-canvas developer-tools atmosphere.

colors:
  primary: "#292524"
  primary-active: "#0c0a09"
  ink: "#0c0a09"
  body: "#4e4e4e"
  body-strong: "#292524"
  muted: "#777169"
  muted-soft: "#a8a29e"
  hairline: "#e7e5e4"
  hairline-soft: "#f0efed"
  hairline-strong: "#d6d3d1"
  canvas: "#f5f5f5"
  canvas-soft: "#fafafa"
  canvas-deep: "#0c0a09"
  surface-card: "#ffffff"
  surface-strong: "#f0efed"
  surface-dark: "#0c0a09"
  surface-dark-elevated: "#1c1917"
  on-primary: "#ffffff"
  on-dark: "#ffffff"
  on-dark-soft: "#a8a29e"
  gradient-mint: "#a7e5d3"
  gradient-peach: "#f4c5a8"
  gradient-lavender: "#c8b8e0"
  gradient-sky: "#a8c8e8"
  gradient-rose: "#e8b8c4"
  semantic-error: "#dc2626"
  semantic-success: "#16a34a"

typography:
  display-mega:
    fontFamily: "'EB Garamond', 'Cormorant Garamond', 'Times New Roman', serif"
    fontSize: 64px
    fontWeight: 300
    lineHeight: 1.05
    letterSpacing: -1.92px
  display-xl:
    fontFamily: "'EB Garamond', 'Cormorant Garamond', serif"
    fontSize: 48px
    fontWeight: 300
    lineHeight: 1.08
    letterSpacing: -0.96px
  display-lg:
    fontFamily: "'EB Garamond', 'Cormorant Garamond', serif"
    fontSize: 36px
    fontWeight: 300
    lineHeight: 1.17
    letterSpacing: -0.36px
  display-md:
    fontFamily: "'EB Garamond', 'Cormorant Garamond', serif"
    fontSize: 32px
    fontWeight: 300
    lineHeight: 1.13
    letterSpacing: -0.32px
  display-sm:
    fontFamily: "'EB Garamond', 'Cormorant Garamond', serif"
    fontSize: 24px
    fontWeight: 300
    lineHeight: 1.2
    letterSpacing: 0
  editorial-serif-accent:
    fontFamily: "'EB Garamond', 'Cormorant Garamond', 'Playfair Display', 'Times New Roman', serif"
    fontSize: inherit
    fontWeight: 300
    lineHeight: inherit
    letterSpacing: -0.01em
    usage: "Use as a local editorial accent inside otherwise Inter-led UI: brand marks, sidebar titles, modal headings, empty-state headings, quote fragments, stat numerals, or one emphasized phrase. Do not use for body copy, buttons, navigation, form labels, logs, code, or dense operational tables."
  editorial-serif-accent-italic:
    fontFamily: "'EB Garamond', 'Cormorant Garamond', 'Playfair Display', 'Times New Roman', serif"
    fontSize: inherit
    fontStyle: italic
    fontWeight: 300
    lineHeight: inherit
    letterSpacing: -0.01em
    usage: "Italic variant of editorial-serif-accent: for the single emphasized word/phrase in a line — e.g. the 'one' in a hero headline 'work as one', or one emphasized word in empty states or pricing. Limited to a single emphasized phrase; never for full headings, body copy, navigation, buttons, or code."
  title-md:
    fontFamily: "'Inter', sans-serif"
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: 0
  title-sm:
    fontFamily: "'Inter', sans-serif"
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.44
    letterSpacing: 0.18px
  body-md:
    fontFamily: "'Inter', sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.16px
  body-strong:
    fontFamily: "'Inter', sans-serif"
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0.16px
  body-sm:
    fontFamily: "'Inter', sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.47
    letterSpacing: 0.15px
  caption:
    fontFamily: "'Inter', sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  caption-uppercase:
    fontFamily: "'Inter', sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.96px
    textTransform: uppercase
  button:
    fontFamily: "'Inter', sans-serif"
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: 0
  nav-link:
    fontFamily: "'Inter', sans-serif"
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0

rounded:
  none: 0px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  xxl: 24px
  pill: 9999px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  base: 16px
  md: 20px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 96px

components:
  top-nav:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.nav-link}"
    height: 64px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 10px 20px
    height: 40px
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
  button-outline:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: 9px 19px
    height: 40px
  button-tertiary-text:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.button}"
  hero-band:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.display-mega}"
    padding: 96px
  editorial-serif-accent:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.editorial-serif-accent}"
    allowedContexts: "Brand mark letters, compact page titles, modal/dialog titles, empty states, testimonial pull-quotes, stat numerals, and one emphasized phrase inside a large display headline."
    maxUsage: "One accent moment per component or dense viewport. If the whole block is already EB Garamond display, do not add a second accent inside it."
  gradient-orb-card:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xxl}"
    padding: 32px
  feature-card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.title-md}"
    rounded: "{rounded.xl}"
    padding: 24px
  product-card-stack:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 0
  list-row:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    padding: 12px 0
  avatar-circular:
    backgroundColor: "{colors.surface-strong}"
    rounded: "{rounded.full}"
    size: 32px
  pricing-tier-card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 32px
  pricing-tier-featured:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 32px
  text-input:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 12px 16px
    height: 44px
  badge-pill:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.ink}"
    typography: "{typography.caption-uppercase}"
    rounded: "{rounded.pill}"
    padding: 4px 10px
  cta-band:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.display-lg}"
    padding: 96px
  testimonial-card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.body}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 32px
  footer:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    padding: 64px 48px
  footer-link:
    backgroundColor: transparent
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
---

## Overview

open-tag's warm-editorial design system reads like a quietly editorial print magazine. The base canvas is off-white `{colors.canvas}` (#f5f5f5) holding warm near-black ink `{colors.ink}` (#0c0a09). Visual energy is **atmospheric, not chromatic**: soft pastel gradient orbs (mint, peach, lavender, sky, rose) drift through the page as the only deliberate "color" moments. There is no neon accent, no saturated CTA color, no dark-canvas developer-tools atmosphere.

Type pairs **EB Garamond Light** (open-source serif at weight 300) for display with **Inter** for body, navigation, captions, and buttons. The display weight at 300 is the editorial signature — never bold, never heavy. Licensed alternatives such as GT Sectra are also compatible if closer optical fidelity to a narrower modern serif is desired.

CTAs are subtle: a near-black ink pill (`{component.button-primary}`) is the primary, a transparent outline (`{component.button-outline}`) is the secondary. The system trusts atmospheric composition and modest type weights to carry all brand work.

**Key Characteristics:**
- Off-white canvas, warm near-black ink. No saturated CTA color.
- Single primary action: ink pill at `{rounded.pill}`. Atmospheric gradients carry visual energy.
- Display runs EB Garamond Light at weight 300 — the editorial magazine voice.
- Body runs Inter at 400 with subtle letter-spacing (+0.15–0.18px).
- Pastel gradient orbs (5 tokens: mint, peach, lavender, sky, rose) used as atmospheric decoration only.
- Soft pill geometry (`{rounded.pill}` for CTAs, `{rounded.xl}` for cards).
- 96px section rhythm.

## Colors

### Brand & Accent
- **Ink Primary** (`{colors.primary}` — #292524): The primary action color — warm near-black pill. Used scarcely.
- **Ink Primary Active** (`{colors.primary-active}` — #0c0a09): Press state.

### Surface
- **Canvas** (`{colors.canvas}` — #f5f5f5): Off-white page floor.
- **Canvas Soft** (`{colors.canvas-soft}` — #fafafa): Lighter band for subtle alternating sections.
- **Canvas Deep** (`{colors.canvas-deep}` — #0c0a09): Same as ink — used for the rare dark-mode hero band.
- **Surface Card** (`{colors.surface-card}` — #ffffff): Pure white card.
- **Surface Strong** (`{colors.surface-strong}` — #f0efed): Badges, avatar plates.
- **Surface Dark** (`{colors.surface-dark}` — #0c0a09): Dark hero/CTA band canvas.
- **Surface Dark Elevated** (`{colors.surface-dark-elevated}` — #1c1917): Cards on dark canvas.

### Hairlines
- **Hairline** (`{colors.hairline}` — #e7e5e4): Default 1px divider.
- **Hairline Soft** (`{colors.hairline-soft}` — #f0efed): Lighter divider.
- **Hairline Strong** (`{colors.hairline-strong}` — #d6d3d1): Stronger panel outline.

### Text
- **Ink** (`{colors.ink}` — #0c0a09): Display, primary text.
- **Body** (`{colors.body}` — #4e4e4e): Default running-text.
- **Body Strong** (`{colors.body-strong}` — #292524): Same as primary — emphasis.
- **Muted** (`{colors.muted}` — #777169): Sub-titles.
- **Muted Soft** (`{colors.muted-soft}` — #a8a29e): Disabled text.
- **On Primary** (`{colors.on-primary}` — #ffffff): White text on ink pill.
- **On Dark** (`{colors.on-dark}` — #ffffff): White text on dark hero.
- **On Dark Soft** (`{colors.on-dark-soft}` — #a8a29e): Muted off-white on dark.

### Atmospheric Gradient Stops (signature)
- **Gradient Mint** (`{colors.gradient-mint}` — #a7e5d3): Mint green orb.
- **Gradient Peach** (`{colors.gradient-peach}` — #f4c5a8): Peach orb.
- **Gradient Lavender** (`{colors.gradient-lavender}` — #c8b8e0): Lavender orb.
- **Gradient Sky** (`{colors.gradient-sky}` — #a8c8e8): Sky-blue orb.
- **Gradient Rose** (`{colors.gradient-rose}` — #e8b8c4): Rose orb.

These appear ONLY as soft radial-gradient atmospheric orbs inside `{component.gradient-orb-card}` and as background atmospheric blooms behind hero copy. Never as button fills, never as text colors.

### Semantic
- **Success** (`{colors.semantic-success}` — #16a34a): Confirmation.
- **Error** (`{colors.semantic-error}` — #dc2626): Validation errors.

## Typography

### Font Family
**EB Garamond Light** (open-source) is the display serif at weight 300. **Inter** carries body, navigation, captions, and buttons. Fallback: `'Cormorant Garamond', 'Times New Roman', serif` for EB Garamond, `sans-serif` for Inter. Licensed alternatives such as GT Sectra are compatible display serif substitutes.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-mega}` | 64px | 300 | 1.05 | -1.92px | Homepage hero h1 |
| `{typography.display-xl}` | 48px | 300 | 1.08 | -0.96px | Subsidiary heroes |
| `{typography.display-lg}` | 36px | 300 | 1.17 | -0.36px | Section heads |
| `{typography.display-md}` | 32px | 300 | 1.13 | -0.32px | Sub-section heads |
| `{typography.display-sm}` | 24px | 300 | 1.2 | 0 | Card group titles |
| `{typography.editorial-serif-accent}` | inherit | 300 | inherit | -0.01em | Local serif accent inside Inter-led UI |
| `{typography.title-md}` | 20px | 500 | 1.35 | 0 | Component titles — Inter |
| `{typography.title-sm}` | 18px | 500 | 1.44 | 0.18px | List labels |
| `{typography.body-md}` | 16px | 400 | 1.5 | 0.16px | Default body — Inter |
| `{typography.body-strong}` | 16px | 500 | 1.5 | 0.16px | Emphasized body |
| `{typography.body-sm}` | 15px | 400 | 1.47 | 0.15px | Footer body |
| `{typography.caption}` | 14px | 400 | 1.5 | 0 | Photo captions |
| `{typography.caption-uppercase}` | 12px | 600 | 1.4 | 0.96px | Section labels, badges |
| `{typography.button}` | 15px | 500 | 1.0 | 0 | CTA pill |
| `{typography.nav-link}` | 15px | 500 | 1.4 | 0 | Top-nav menu |

### Principles
- **Display weight stays at 300.** EB Garamond Light is the editorial signature. Never bold display copy.
- **Serif accent is reusable, not hero-only.** Use `{typography.editorial-serif-accent}` for short brand/accent moments inside Inter-led UI: the brand mark, sidebar title, modal title, empty-state phrase, testimonial pull-quote, stat numeral, or one emphasized phrase inside a headline.
- **Subtle letter-spacing on body.** Inter at +0.15–0.18px tracking — slightly looser than default Inter for a more editorial feel.
- **Negative letter-spacing on display.** EB Garamond pulls -0.32px to -1.92px tighter on display sizes.
- **Restraint keeps the accent premium.** One serif accent per component is usually enough; using it on every label makes the product feel like a template, not a design system.

### Note on Font Substitutes
EB Garamond is the open-source default at weight 300 (slightly humanist). Cormorant Garamond is a close alternative. GT Sectra (licensed) provides a more modern, narrower optical character if desired. Use Inter directly for body.

## Layout

### Spacing System
- **Base unit:** 4px.
- **Tokens:** `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.base}` 16px · `{spacing.md}` 20px · `{spacing.lg}` 24px · `{spacing.xl}` 32px · `{spacing.xxl}` 48px · `{spacing.section}` 96px.
- **Section padding:** 96px.

### Grid & Container
- Max content width: ~1200px.
- Editorial body: 12-column grid.
- Feature card grids: 2-up at desktop for hero splits, 3-up for benefit grids.
- Footer: 5-column at desktop.

### Whitespace Philosophy
Generous editorial pacing — print-magazine feel. 96px between bands; cards inside bands sit close (16–24px gap). The atmospheric gradient orbs occupy generous breathing space without competing with copy.

## Elevation & Depth

The system uses **hairline + restrained drop shadow**. Flat surfaces float above the off-white canvas via 1px hairlines; transient overlays (menus, modals, hovercards, lightbox) add depth through a shadow opacity scale. Atmospheric depth comes from gradient orbs.

| Level | Treatment | Use |
|---|---|---|
| Flat (canvas) | `{colors.canvas}` (#f5f5f5) | Body bands, footer |
| Card | `{colors.surface-card}` (#ffffff) | Content cards |
| Hairline border | 1px `{colors.hairline}` | Card outlines |
| Gradient orb | Radial gradient with one of `{colors.gradient-*}` | Atmospheric depth — never a card surface |

**Shadow opacity scale** (`--shadow-1`…`--shadow-7` in `styles.css` `:root` — black at increasing alpha; combined with per-component offset/blur so depth stays consistent and detector-clean):

| Token | Alpha | Typical use |
|---|---|---|
| `--shadow-1` | .05 | Raised / active (rail active icon) |
| `--shadow-2` | .10 | Low float (message hover toolbar) |
| `--shadow-3` | .12 | Modals, popovers, menus, cards, agent hovercard |
| `--shadow-4` | .16 | Context (right-click) menu |
| `--shadow-5` | .25 | Toggle knob lift |
| `--shadow-6` | .30 | Lightbox close button (over scrim) |
| `--shadow-7` | .45 | Lightbox image (over scrim) |

### Decorative Depth
- **Pastel gradient orbs** are the system's strongest atmospheric pattern. Soft radial blooms in mint, peach, lavender, sky, or rose drift through hero bands and feature sections without containing any content — they are pure atmosphere.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Reserved |
| `{rounded.xs}` | 4px | Inline tags |
| `{rounded.sm}` | 6px | Compact rows |
| `{rounded.md}` | 8px | Form inputs |
| `{rounded.lg}` | 12px | Compact cards |
| `{rounded.xl}` | 16px | Feature cards, pricing tiers |
| `{rounded.xxl}` | 24px | Gradient orb cards (extra-soft) |
| `{rounded.pill}` | 9999px | All CTA buttons, badges |
| `{rounded.full}` | 9999px | Avatar circles |

## Components

### Top Navigation

**`top-nav`** — Background `{colors.canvas}`, text `{colors.ink}`, height 64px. Layout: wordmark left, primary horizontal menu, Sign In + primary CTA right.

### Buttons

**`button-primary`** — Near-black ink pill. Background `{colors.primary}`, text `{colors.on-primary}`, type `{typography.button}` (15px / 500), padding 10px × 20px, height 40px, rounded `{rounded.pill}`.

**`button-primary-active`** — Press state. Background `{colors.primary-active}`.

**`button-outline`** — Transparent pill with 1px ink border. Background transparent, text `{colors.ink}`, 1px `{colors.hairline-strong}` border.

**`button-tertiary-text`** — Inline ink text link.

### Hero & Atmospheric

**`hero-band`** — Background `{colors.canvas}`, full-width display headline in `{typography.display-mega}` (64px / 300 / -1.92px), subhead in `{typography.body-md}`, two CTAs, and an atmospheric gradient orb behind the centered headline.

**`editorial-serif-accent`** — Local serif emphasis for otherwise Inter-led surfaces. Use it for brand mark letters, compact page titles, modal headings, empty states, testimonial pull-quotes, stat numerals, or one phrase inside a larger headline. This is the reusable "serif accent" pattern; it is not limited to hero titles. Keep it short and sparse.

**`gradient-orb-card`** — A large card with a soft radial-gradient orb behind centered display copy. Background `{colors.canvas-soft}`, rounded `{rounded.xxl}` (24px), padding 32px. Each variant uses one of the five gradient tokens (`gradient-mint`, `gradient-peach`, `gradient-lavender`, `gradient-sky`, `gradient-rose`).

### Cards

**`feature-card`** — 2-up or 3-up grids. Background `{colors.surface-card}`, text `{colors.ink}`, rounded `{rounded.xl}`, padding 24px, 1px hairline border.

**`product-card-stack`** — Stacked product preview cards. Background `{colors.surface-card}`, rounded `{rounded.xl}`, no padding (children fill the card edge-to-edge).

**`testimonial-card`** — Quote card. Background `{colors.surface-card}`, text `{colors.body}`, rounded `{rounded.xl}`, padding 32px.

### List Rows & Avatars

**`list-row`** — Horizontal row in a list. Background transparent, 1px hairline divider. Layout: 32px circular avatar (`{component.avatar-circular}`) left, name + metadata stack, optional action right.

**`avatar-circular`** — Background `{colors.surface-strong}`, rounded `{rounded.full}`, 32px diameter. Holds initials or icon glyph.

### Pricing

**`pricing-tier-card`** — Background `{colors.surface-card}`, rounded `{rounded.xl}`, padding 32px, 1px hairline border.

**`pricing-tier-featured`** — Featured tier inverts. Background `{colors.surface-dark}`, text `{colors.on-dark}`. Same shape, dark inversion.

### Forms & Tags

**`text-input`** — Background `{colors.surface-card}`, text `{colors.ink}`, rounded `{rounded.md}` (8px), padding 12px × 16px, height 44px, 1px `{colors.hairline-strong}` border. On focus, border thickens to 2px ink.

**`badge-pill`** — Background `{colors.surface-strong}`, text `{colors.ink}`, type `{typography.caption-uppercase}`, rounded `{rounded.pill}`, padding 4px × 10px.

### CTA / Footer

**`cta-band`** — Pre-footer. Background `{colors.canvas}`, centered display headline in `{typography.display-lg}`, single ink pill CTA. 96px padding.

**`footer`** — Closing footer. Background `{colors.canvas}`, text `{colors.body}`. 5-column link list. 64×48px padding.

**`footer-link`** — Background transparent, text `{colors.body}`, type `{typography.body-sm}`.

## Do's and Don'ts

### Do
- Reserve `{colors.primary}` (ink pill) for primary CTAs.
- Use EB Garamond Light at weight 300 for every display headline. Never bold.
- Use `{typography.editorial-serif-accent}` for short brand/accent moments outside hero: sidebar title, modal title, empty-state phrase, testimonial pull-quote, stat numeral, or a single emphasized phrase.
- Use Inter at +0.15–0.18px tracking for body — the editorial dialect.
- Use atmospheric gradient orbs (mint/peach/lavender/sky/rose) as decoration only.
- Use the pill shape for every CTA and badge.

### Don't
- Don't introduce a saturated brand action color. Ink pill is the only CTA color.
- Don't bold display copy. Display sits at weight 300 — bolding shifts the voice from editorial to consumer-marketing.
- Don't use the serif accent for nav links, buttons, dense lists, body paragraphs, form labels, logs, code blocks, or operational table cells.
- Don't use gradient orbs as button fills, text colors, or component backgrounds. They are pure atmosphere.
- Don't use sharp `{rounded.none}` (0px) on CTAs. Pill geometry is the design system's button shape.
- Don't drop body Inter to weight 300 to match the display serif — body stays at 400/500 for legibility.

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Mobile | < 640px | Hero h1 64→32px; feature cards 1-up; nav hamburger; gradient orbs shrink. |
| Tablet | 640–1024px | Hero h1 48px; feature cards 2-up. |
| Desktop | 1024–1280px | Full hero h1 64px; feature cards 3-up. |
| Wide | > 1280px | Content caps at 1200px. |

### Touch Targets
- Primary pill at 40px height — at WCAG AA, padded for AAA.
- Avatar circles 32px — padded row creates effective 48px tap zone.

### Collapsing Strategy
- Top nav switches to hamburger below 768px.
- Feature grid: 3-up → 2-up → 1-up.
- Gradient orbs reduce diameter at every breakpoint but never disappear.

## Iteration Guide

1. Focus on a single component at a time.
2. CTAs default to `{rounded.pill}`. Cards use `{rounded.xl}` (16px).
3. Variants live as separate entries.
4. Use `{token.refs}` everywhere — never inline hex.
5. Hover state never documented inline; implement per-component.
6. EB Garamond 300 for display, Inter 400/500 for body.
7. Gradient orbs scoped to atmospheric decoration.

## Known Gaps

- Animation timings (orb drift, hero entrance) out of scope. **Icon micro-interactions are an exception** — specified in [`docs/icon-motion.md`](./docs/icon-motion.md) and implemented by `web/src/iconMotion.css` (shared `--im-spring` overshoot curve, two-class `im` / `im-*` API).
- In-product application surfaces only partially specified here; extend tokens as needed.
- Form validation states beyond focus not fully specified.
