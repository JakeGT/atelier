# 05 — Visual language

Part of the [interface design reference](README.md).

Atelier builds websites, so its own interface is the proof. It should look
made, not assembled. But clarity comes first: where a stylish choice makes
something harder to find or understand, the plain choice wins
([01](01-words-on-controls.md), [02](02-finding-things.md)).

The values live in `apps/web/src/styles/tokens.css`. Components use tokens,
never raw colours or sizes.

## Idea

A studio: warm paper, ink, and one vermilion accent (the maker's seal).

## Colour

| Token | Use |
| --- | --- |
| `--paper`, `--paper-deep` | Page background |
| `--surface`, `--surface-raised` | Fields, cards, dialogs, menus |
| `--ink`, `--ink-2`, `--ink-3` | Text: main, secondary, quiet |
| `--line`, `--line-strong` | Borders and dividers |
| `--seal` | The one accent: the primary action (Publish, Send) and warnings |
| `--live` | Public, connected, healthy |
| `--draft` | Changed but not yet public; waiting |

Rules:

- **Colour carries meaning, and the meaning is always also in words.** Green means live, amber means not-yet-public, vermilion means "the main thing to do here" or "careful".
- One primary (vermilion) button per screen.
- Two themes, **paper** (light) and **night** (dark). Every screen is checked in both.

## Type

| Face | Use |
| --- | --- |
| Instrument Serif | Display: page titles, dialog titles, website names. One italic accent word per title at most |
| Geist | Everything you read or press |
| Geist Mono | Small facts: times, addresses, counts, eyebrow labels |

- Body text is 14–15px; nothing a person must read is below 12px.
- Fonts are bundled. Nothing loads from another company's servers.

## Shape and space

- Radii from the tokens (`--radius-s` to `--radius-xl`); pills for buttons and status chips.
- Spacing from the 4px scale (`--space-1` to `--space-9`).
- Generous space around the one thing each screen is for.

## Components

| Component | Notes |
| --- | --- |
| Button | Words always. `btn-seal` primary, `btn-primary` ink, plain, `btn-ghost`, `btn-danger` |
| Status chip | A word in a coloured pill. As a button (`chip-button`) it opens what can be done about that status |
| Menu | Words on every item; a divider before anything dangerous |
| Dialog | Eyebrow, serif title, one short paragraph, the thing itself, outcome-named buttons |
| Rows | Name and state on the left, that row's actions on the right |
| Toast | A short result. Errors stay longer |

## Motion

Short and purposeful: things rise in, menus spring open. Nothing moves in a way
that hides where a control is or delays using it.

## Copy on the page

The studio vocabulary belongs in headings and empty states. Marketing copy
never claims a feature that is not built.
