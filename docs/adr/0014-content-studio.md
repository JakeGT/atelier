# ADR-0014 — Content: one store, bound to the page, edited in three places; a media library

- **Status:** Accepted in practice: the owner said to continue with phase 5 on 2026-10-10. Steps a–h are built (see the two "As built" sections), with the differences they list.
- **Date:** 2026-10-10
- **Extends:** ADR-0002 (content store), ADR-0007 (releases pin content), docs/09

## Context

Atelier has a content store (drafts, published, revisions, pinned per release)
and a small "Wording" panel in the editor. Four things are wrong with it.

1. **Content is not connected to the page.** The assistant writes a headline
   into the HTML and, separately, saves it as content, and is asked to keep the
   two "in step". Editing wording in the panel therefore changes nothing a
   visitor sees until the assistant is asked to copy it across. The store is a
   notebook, not a source of truth.
2. **The only place to edit is a narrow side panel.** Fine for a headline, poor
   for a page of text, a list of services or anything with images.
3. **Fields are whatever the assistant called them** ("Hero title"), with no
   types, no guidance and JSON for anything structured.
4. **There is no media.** A `media_assets` table has existed since P1 and a
   "media library" requirement (FR-D5) was deferred from P2, but nothing
   uploads, stores, resizes or serves a file. People cannot add their own
   photographs, which is the first thing most of them want to do.

How established content systems solve the editing side is consistent: the page
marks which element came from which field, an overlay makes those elements
clickable, and the editing happens in the content system, not in the page's
code (Sanity, DatoCMS and Storyblok all work this way; they differ only in how
the marking is done).

## Decision

### 1. Content is the source of truth, bound to the page by attributes

An element whose content a person may edit carries an attribute naming the
field it shows:

```html
<h1 data-content="page/home#headline">Okoro Ceramics</h1>
<div data-content-rich="page/home#story">…</div>
<img data-content-image="page/home#hero" src="…" alt="…">
<ul data-content-list="collection/services">
  <li><h3 data-content="#name"></h3><p data-content="#summary"></p></li>
</ul>
```

- The assistant's house rules require this for wording a person will want to
  change. The text it writes inside the element is the first value and the
  fallback.
- Explicit attributes, not invisible markers hidden in the text: they are
  plain HTML, survive the assistant rewriting a page, and need no build step.

### 2. The server fills the page; the published site has no script for it

- **In the preview**, the server fills bound elements from the current
  *drafts* as it serves each page. Saving wording shows in the preview at once,
  with no request to the assistant.
- **On publish**, the deployer (trusted, ADR-0010) fills them from the content
  pinned in the release (ADR-0007) before uploading. Visitors get finished
  HTML: nothing to load, nothing for search engines to miss, no flash of old
  text.
- An element with no stored value keeps what is written in it. A website with
  no bound elements behaves exactly as today.
- Plain text is inserted as text. Rich text goes through an allow-list (bold,
  italic, links, lists, headings) on the way in and again on the way out. No
  field can inject markup or script.

### 3. Fields have a type, a label and guidance

Each document carries a small description of its fields, written by the
assistant when it creates the content and editable later:

| Type | Edited as |
| --- | --- |
| Text | One line |
| Long text | Several lines |
| Rich text | A small editor: bold, italic, link, list, heading |
| Link | A page of this website, or an address |
| Image | Chosen from the media library; alt text required |
| List | Items that can be added, removed and reordered |
| Number, date, yes/no | The obvious control |

- The **label is in the person's words** ("Headline", not "heroTitle") and each
  field can carry one line of help ("Shown at the top of the home page").
- Limits (a maximum length, required) are **checked when publishing, not when
  saving**: a draft may be unfinished.
- No JSON is ever shown (docs/design/03).

### 4. Three places to edit, one store

| Where | For | What it is |
| --- | --- | --- |
| **In the preview** | Fixing what you are looking at | An **Edit text** switch on the preview bar outlines everything editable. Click a piece of text and type; click an image to replace it. |
| **In the editor's side panel** | A quick change without leaving the conversation | The list as now, kept small. Each item opens a **pop-up** with room to edit, instead of expanding in the narrow column. |
| **The Content page** | Managing all of it | A full page per website: every page's wording, lists, the media library, history, and what is not yet published. |

All three write the same drafts through the same API, with the same conflict
rule (a save based on an out-of-date revision is refused; docs/design/07).

**In-preview editing, precisely.** The preview frame is sandboxed and holds no
credentials (ADR-0006). The bridge already added to framed pages (for Back and
Forward) is extended: in edit mode it outlines bound elements, makes plain text
editable in place, and sends each change to the editor with `postMessage`. The
editor, not the frame, saves it. Rich text, links, images and lists open the
same pop-up as the side panel, positioned by the element. What a page says is
untrusted: the editor only accepts a field name that exists and a value of that
field's type.

**The Content page** (`/o/:studio/p/:website/content`):

- **Pages** on the left (Home, About, Contact, "Used on every page"), each
  showing its fields in order, with the live preview of that page beside it.
- **Lists** (services, team, opening hours): add, remove, drag to reorder.
- **Media**: the library (§5).
- **History** per piece of content: who changed it and when, with "Go back to
  this".
- **Not yet published**: everything that differs from the live website, in one
  list, with Publish.
- Search across all wording.

### 5. A media library per website

- **What can be uploaded:** images (JPEG, PNG, WebP, AVIF, GIF, SVG), documents
  to download (PDF), short video and audio clips.
- **Images are prepared for the web automatically.** The original is kept. On
  publish, each image used is produced in the widths the page needs and in
  modern formats (AVIF, WebP) with a fallback, and the page's `<img>` becomes a
  responsive one. Nobody is asked to resize anything.
- **Alt text is asked for at upload**, with "This image is only decoration" as
  the other choice. A focal point can be set so crops keep the subject.
- **What is refused or cleaned:** the type is checked from the file itself, not
  its name. SVGs are sanitised (scripts, event handlers, external references
  removed). Location data is stripped from photographs. Size limits apply per
  file and per website.
- **Video.** The host limits a file to 25 MB (Cloudflare Pages). Clips under
  that are hosted with the website, with a poster image. Anything longer is
  added as a link to where it already lives (YouTube, Vimeo) and embedded.
  Proper video hosting (Cloudflare Stream or R2) becomes possible once a studio
  connects its own Cloudflare account (ADR-0013) and is not planned before.
- **Where files live.** In object storage run by the control plane (S3
  compatible; one bucket prefix per studio and website), not in the website's
  git history. `media_assets` records each file, its draft and published
  references, alt text and focal point. A draft image is never public until a
  release ships it; the deployer adds a release's media to the upload.
- **The assistant** can list the library and place an image by reference. It
  cannot delete from it. (Generating images is a separate decision.)
- **Deleting** an image that a published page uses is refused with where it is
  used.

### 6. What does not change

Drafts, releases pinning content, rollback, unpublish, roles (`content.write`,
`media.write`), the activity record, and the rule that the assistant can write
drafts but never publish.

## Consequences

- Wording changes no longer need the assistant, and can no longer drift from
  the page.
- The preview and the deployer both have to parse and rewrite HTML. It must be
  a real HTML parser (not text substitution), it must be the same code in both
  places so the preview is what gets published, and it becomes part of the
  trusted path (ADR-0010).
- Publishing does more work (filling pages, producing image sizes). With the
  current synchronous publish this may need publish to become a background job,
  as agent runs already are.
- Object storage is a new piece of infrastructure to run and back up.
- Image sizes multiply files: the host's limits (20,000 files, 25 MB each) need
  watching for large websites.
- Existing websites keep working unbound. Binding them is something the
  assistant can be asked to do ("make the wording on this page editable").

## To confirm before building

1. **The HTML rewriter.** Which parser, and a test that filled output is
   byte-identical between preview and publish.
2. **Image processing.** The library (it needs a native binary in the deployer
   image), its memory use on large photographs, and how long a publish with
   many new images takes.
3. **Object storage on this platform.** What to run (R2 through the operator's
   Cloudflare account, or a small S3-compatible server beside Postgres) and how
   it is backed up.
4. **How reliably the assistant binds elements** when asked to by its rules,
   across the models people will actually use. If it is unreliable, a check
   after each run that reports unbound headings is the fallback.
5. **Rich text editor.** Build small or adopt one; whichever it is must emit
   only the allow-listed elements.
6. **Lists inside pages.** The template-item approach in §1 needs proving on a
   real page with nested fields and images.

## Alternatives rejected

- **Keep asking the assistant to copy wording into pages.** It is the current
  design and the source of the drift.
- **A script on the published page that loads content.** Works without a build
  step, but visitors and search engines see old or empty text first, and the
  site breaks without JavaScript.
- **Invisible markers in the text ("stega"), as Sanity and DatoCMS use.** Clever
  where a framework renders the page; fragile when an AI rewrites raw HTML, and
  hard to inspect.
- **Adopt a separate CMS product** (Payload, Strapi). Considered in docs/09 and
  rejected for tenancy reasons; that reasoning stands.
- **Media in the website's git repository.** Simple, but every version of every
  photograph stays in history forever and the workspace volume balloons.

## Sources

- Sanity, [Visual editing architecture](https://www.sanity.io/docs/visual-editing/visual-editing-architecture) and [overlays](https://www.sanity.io/docs/overlays-package).
- DatoCMS, [Visual editing](https://www.datocms.com/docs/visual-editing).
- Storyblok, [Visual editor](https://www.storyblok.com/docs/concepts/visual-editor).
- Contentstack, [Constraints vs flexibility: designing for content authors](https://www.contentstack.com/academy/courses/cms-developer-foundations/constraints-vs-flexibility-designing-for-content-authors).
- Lullabot, [The 7 best practices of a good editorial experience](https://www.lullabot.com/articles/7-pillars-good-editorial-experience).
- DatoCMS, [Validations](https://datocms.com/docs/content-modelling/validations) (enforce at publish, not at save).
- ApostropheCMS, [Guide to managing media](https://apostrophecms.com/guides/guide-to-managing-media).
- Enonic, [Best practices for image handling](https://enonic.com/blog/best-practices-image-handling).
- MDN, [The picture element](https://developer.mozilla.org/docs/Web/HTML/Element/picture).
- Vercel, [Best practices for hosting videos](https://vercel.com/kb/guide/best-practices-for-hosting-videos-on-vercel-nextjs-mp4-gif).

## As built: steps a–e (branch `p5-content-studio`, 2026-10-10)

- **Binding and filling** (`services/fill.ts`): `data-content`,
  `data-content-rich`, `data-content-list`, with references of the form
  `kind/slug#field`. `parse5` parses and serialises. A value is placed as a
  text node; rich text passes `sanitizeRich` (an allow-list of twelve elements
  and safe `href`s) when saved and again when placed. A page with no binding is
  never parsed: it is served and published byte for byte.
- **Preview** (`/preview/…`): bound pages are filled from drafts on every
  request.
- **Publish:** the control plane sends the deployer the release's content
  alongside the files (a form with `archive` and `content`); the deployer fills
  each HTML file before hashing and uploading. The workspace's files are not
  changed: wording travels with the release, so putting an earlier release back
  puts its wording back.
- **Fields** (`content_documents.fields`, migration 0013): key, label, type
  (`text`, `long`, `rich`, `list`), help. Set by the assistant's
  `content_upsert_draft` tool or `PUT …/content/:kind/:slug/fields`. A document
  without them has its fields worked out from its values.
- **House rules** now tell the assistant to save wording with described fields
  and to mark the element that shows it.
- **Three places to edit**, all saving through the same API with the same
  conflict check:
  - *In the preview:* **Edit text** on the preview bar. The bridge
    (`assets/preview-bridge.js`) outlines bound elements; plain text is typed in
    place and reported on Enter or on leaving the element; formatted text and
    lists open the pop-up. The editor accepts only a well-formed reference and
    a short string, and does the saving.
  - *The pop-up* from the side panel (`editor/Wording.tsx`), with a small
    formatting toolbar for rich text.
  - *The Content page* (`/o/:studio/p/:website/content`): pages on the left
    with search, the fields in the middle with earlier versions and "Go back to
    this", the page's preview on the right, and a line listing what is not yet
    published.

**Differences from the decision above, and what is left:**

- Lists are lists of short lines (each item is a copy of the first, with the
  line as its text). Lists of items with several fields each ("services" with a
  name, a summary and a price) are not built.
- Links, numbers, dates and yes/no fields are not built: text, long text, rich
  text and list are.
- Images (`data-content-image`) wait for the media library.
- Limits checked at publish (required, maximum length) are not built.
- The Content page has no "lists" or "media" sections and no reordering.
- Existing websites are not bound until the assistant is asked to do it
  ("make the wording on this website editable").
- Whether assistants bind reliably has not been measured against real models
  (the first item under "To confirm"); it was exercised with pages written by
  hand.

## As built: the media library, steps f–h (branch `p5-media`, 2026-10-10)

The owner chose Cloudflare R2 for storage on 2026-10-10.

- **Storage** (`services/mediaStorage.ts`): an R2 bucket through its
  S3-compatible API, signed here with AWS Signature V4 (checked against Amazon's
  published examples). Keys are `<studio id>/<website id>/<file name>`, built
  from ids only. The control plane holds the bucket's key; workspaces and the
  deployer do not. In development the files are in a folder. With nothing
  configured the library says uploading is not switched on.
- **Upload** (`services/media.ts`, `routes/media.ts`): what a file is comes from
  its bytes. JPEG, PNG, WebP, AVIF, GIF, SVG, PDF, MP4, WebM, MP3 and M4A are
  taken, up to 25 MB each, 500 MB and 1,000 files per website. Photographs are
  turned upright, capped at 2,560 px wide and re-encoded, which drops camera and
  location data, and get WebP copies 480, 960 and 1,600 px wide. SVGs are reduced
  to an allow-list of drawing elements: no script, handlers, links or anything
  fetched from elsewhere.
- **Description:** a picture is not added until it has one sentence saying what
  it shows, or is marked as decoration.
- **In pages:** a file is `media/<name>` relative to the website's top folder.
  The assistant lists the library with the `media_list` tool (descriptions and
  sizes; it cannot see, add or remove files). `<img data-content-image="page/home#photo">`
  with a field of type `image` is filled with the chosen file, its description,
  its size and a `srcset` of its copies; the person changes it with **Choose a
  picture**.
- **Preview:** `/preview/<token>/media/<name>` serves library files.
- **Publish:** the control plane finds every `media/<name>` that the release's
  files or wording mention and sends those files to the deployer with the
  archive; the deployer serves them under `/media/`. A file nothing mentions is
  never published.
- **Removing:** refused with where the file is used, unless the person says to
  remove it anyway. A removed file leaves the library at once and is deleted
  for good after 30 days, so an earlier release that used it can be put back in
  the meantime.
- **Where it shows:** the Content page has two tabs, **Wording** and **Pictures
  and files**.

**Differences from §5, and what is left:**

- Smaller copies are made at upload, not at publish, and in WebP only (no AVIF
  copies). The published page offers them through `srcset`; it is not rewritten
  into a `<picture>` element.
- The original is not kept: the stored file is the re-encoded one, at most
  2,560 px wide. That is what removes location data.
- No focal point.
- Video: clips up to 25 MB can be uploaded and placed. There is no poster image
  (that needs a video tool in the image) and no special handling of YouTube or
  Vimeo links; the assistant embeds those as ordinary HTML.
- Publishing sends media through the deployer in memory. Websites with hundreds
  of megabytes of media would need the deployer to fetch from storage itself.
- R2 is off this machine, so the files survive the loss of the host; their
  records are in Postgres and are in its backups. The bucket itself has no
  second copy.

## As built: lists of items, and checks before publishing (branch `p5-finish`, 2026-10-10)

- **Lists of items with several parts** (services, menu entries, team members).
  A field of type `items` describes each entry's parts in `itemFields` (text,
  long text, rich text, image, link); its value is an array of objects. In the
  page the list is `data-content-list` as before, and inside its first entry
  each part is marked `data-item`, `data-item-rich`, `data-item-image` or, on a
  link, `data-item-href`. Every entry is a copy of the first entry's markup. A
  part an entry does not have is emptied, and its link or picture is left out,
  so an entry never shows the first entry's sample content. This differs from
  §1's sketch (`collection/services` with `data-content="#name"`): items live
  in a field of the page's document, not in a separate collection.
- **In the editor** each entry is a card of labelled fields with **Add**,
  **Move up**, **Move down** and **Remove**.
- **Checks before publishing.** A field (or a part of an item) can be marked
  `required` and given a `max` (characters, or entries). A draft may break
  these; creating a release may not, and says which field on which page in a
  sentence. The form shows "needed before publishing" and how much room is left
  once it is nearly used.

Still not built: number, date and yes/no fields; reordering by dragging; a
focal point for images; poster images for video.

## As built: content a person can read and place (branch `content-clarity`, 2026-10-10)

The owner opened the Content page on websites made before fields and binding
existed and found raw JSON, with no way to tell what any of it was or where it
went. Three things changed.

- **A person is never shown JSON.** Content is stored as JSON because that
  suits the assistant. `editor/Wording.tsx` turns any saved value into fields:
  a line, a paragraph, formatted text, a list, a picture, a link, a number, a
  yes/no, a group of related fields (a nested object), or entries with parts (an
  array of objects), to any depth. Edits keep the stored shape.
- **Every piece says where it appears.** `GET …/content/map` reads the
  website's pages and returns which fields each page's elements are bound to.
  Beside each field the Content page shows **Show me where · Home page**;
  choosing it (or just starting to edit the field) takes the preview to that
  page, scrolls to the element and marks it. The preview on the Content page
  outlines what can be edited: clicking a part of the page finds its field, and
  a line of text can be typed in place.
- **Wording no page shows is said to be so.** A field with no element is marked
  **Not on the website yet**, a section with none says so in the list, and a
  notice at the top explains that changing it will not change the website, with
  **Ask my assistant to connect it**. That opens the editor with the request
  written in the message box for the person to read and send. The assistant's
  rules now say to keep fields flat and how to connect older wording (keep
  every word, reshape nested values, describe every field, mark every element).
  Tried once with the real assistant on a two-page website with nested content:
  all twelve pieces were connected and every word was kept.

Both ways of reaching things that could not be found were also fixed: a
**Content** button in the editor's bar, a **Pictures** tab in its side panel,
and **Add pictures or files** beside the message box.
