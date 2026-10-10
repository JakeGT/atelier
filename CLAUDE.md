# Working on Atelier

Start with [`HANDOFF.md`](HANDOFF.md): what is built, what is deployed, and what is next.

## Rules that always apply

- **The interface follows [`docs/design/README.md`](docs/design/README.md).** Read it before
  building or changing anything a person sees, and run
  [`docs/design/06-review-checklist.md`](docs/design/06-review-checklist.md) before it ships.
  In short: every control has words (an icon never stands in for them); an action lives on the
  thing it acts on; nothing technical is shown to people; risky actions say what will happen.
  If someone cannot find something, fix the design rather than explain where it is.
- **Each phase is developed on its own branch** and reviewed as a pull request. Nothing goes
  straight to `main`.
- **After every push, check CI** (`gh pr checks <n>`). Never commit key-shaped literals, even
  in tests.
- **Look at the real thing.** Interface work is checked with screenshots of the running app
  (light, dark, phone), and server work with `pnpm test` and `scripts/e2e.sh`.

## Where things are

| What | Where |
| --- | --- |
| The plan and what each phase built | `docs/13-implementation-plan.md` |
| Decisions and why | `docs/adr/` |
| Interface design | `docs/design/` |
| Web app | `apps/web/src/` |
| Server | `apps/server/src/` |
