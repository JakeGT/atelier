# 03 — Plain language

Part of the [interface design reference](README.md).

## The rule

Everything the interface says is written for someone who has never built a
website. Nothing shown to them is something only we would understand.

## Never show internals

| Do not show | Show instead |
| --- | --- |
| Commit hashes (`3b31b15`) | When it happened, and what the request was |
| Ids, revision numbers (`rev 4`) | "Last changed 2 hours ago" |
| Database state names (`planned`, `superseded`, `failed`) | "Not published", "Was live", "Didn't publish" |
| Slugs where a name exists (`field-notes`) | The name ("Field Notes") |
| Raw paths (`/o/acme-1a2b`) | The full link a person could copy |
| JSON | Ordinary fields; a list is edited one per line |
| Error codes, stack traces | What happened, in a sentence |

If something structured genuinely cannot be shown as fields, say so plainly and
point to the easier route ("structured: easier to ask your assistant").

## Use their word, not ours

Name things by what they are to the person. The glossary below is the single
list. Before inventing a term, look for it here; when you add one, add it here.

## Glossary

| We say | Meaning | We do not say |
| --- | --- | --- |
| **Website** | One site a person is building | Project |
| **Studio** | A space with its own websites, members and usage | Organisation, tenant, workspace |
| **Your personal studio** | The studio everyone has from the start; always theirs | Default org, home tenant |
| **Shared studio** | A studio made to work in with other people | Team, organisation |
| **Add someone** | Give a person who already uses Atelier a place in a studio | Invite (access to Atelier itself is given elsewhere) |
| **Your assistant** | The AI that builds the website | Agent, model, bot |
| **Version** | A saved state of the website after one request to the assistant | Checkpoint, commit |
| **Go back to this** | Make an earlier version the current one | Restore, revert, reset |
| **Publish** | Make the current version public | Deploy, release (as a verb) |
| **Release 3** | The third time this website was published | Deployment, build |
| **Live** / **Public** | What visitors can see right now | Production, deployed |
| **Put this one back** | Publish an earlier release again | Roll back |
| **Unpublish** / **Take offline** | Stop the website being public; keep everything else | Undeploy, tear down |
| **Wording** | Text on the website the person can edit directly | Content documents, CMS, drafts |
| **Edit text** | The switch on the preview that lets wording be typed into the page | Inline editing, visual editing, WYSIWYG |
| **Media** | Images, video, audio and documents uploaded to a website | Assets, blobs |
| **Content** | Wording and media together; the name of the page that manages both (planned) | CMS, content store |
| **Not published yet** | Changed since the last publish | Draft, dirty, staged |
| **Address** | Where the website is on the internet | URL, origin, hostname |
| **Your own domain** | An address the person owns, such as `www.example.com` | Custom domain, canonical origin |
| **Provider** | A company whose AI the assistant can use | Vendor, upstream |
| **API key** | The password-like code a provider gives you | Secret, credential, token |
| **Paused** | A request that ran out of time; its work is kept | Timed out, killed |
| **Carry on from here** | Continue a request that was stopped or paused | Resume, retry |
| **Start from** / **starting point** | A finished small website to begin a new one from | Template (fine in passing), boilerplate, scaffold |
| **Ideas for what to ask** | Ready-made requests that fill the message box | Skills, prompts, recipes |
| **Suspended** | A studio the operator has paused | Disabled, deactivated, banned |
| **Archive** | Hide a website and stop its assistant; nothing is deleted | Disable, deactivate |
| **Member** | Someone who can open a studio | User, principal |

## Technical terms we cannot avoid

Some words come from outside Atelier and the person will meet them elsewhere:
**API key**, **token** (the unit AI use is counted in), **CNAME record**,
**DNS**. When one appears:

- say what it is in one sentence, in the same place;
- say exactly what to do with it ("add a CNAME record for `www.example.com` pointing to …");
- link to where the person gets it, if it comes from another company.

## Tone

- Short sentences. Say the thing.
- Speak to the person: "your website", "your assistant".
- Say what will happen, not how it works.
- No exclamation marks, no "Oops", no blame ("you entered an invalid…").
- British spelling.
- The studio vocabulary (atelier, studio, seal) is flavour for headings and empty states. It never replaces a plain label on a control.
