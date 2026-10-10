# ADR-0013 — A studio connects its own Cloudflare account, by OAuth

- **Status:** Proposed (planned as P4 epic E4.5; nothing is built)
- **Date:** 2026-10-10
- **Extends:** ADR-0004 (hosting), ADR-0010 (the deployer), ADR-0011 (stored secrets)

## Context

Today every published website lives in one Cloudflare account, the operator's,
reached with one account API token held by the deployer (ADR-0004, ADR-0010).
That is right for a private instance and wrong for a product: the operator pays
for and is responsible for everyone's sites, a studio cannot see or keep its
sites outside Atelier, and domains on a studio's own Cloudflare account cannot
be set up for it.

The model we already use for AI is "bring your own": a studio connects its own
provider and pays it directly (ADR-0011). Hosting should work the same way.

The obstacle was the connecting. Asking a non-technical person to find
Cloudflare's token page, choose permissions and paste a secret breaks the
interface rules in `docs/design/`. In June 2026 Cloudflare launched OAuth for
third-party applications ("self-managed OAuth clients"), which removes it: the
person approves on a Cloudflare consent screen and comes back connected.

## Decision

1. **A studio may connect its own Cloudflare account. It is optional.** A
   studio that connects nothing keeps using the operator's account, exactly as
   now. (An operator may turn the shared account off, so that connecting is
   required; that is a setting, not a different design.)

2. **Connecting is one button, "Connect Cloudflare", using OAuth.** Atelier is
   registered as an OAuth client in the operator's Cloudflare account. The flow
   is Authorization Code with a client secret (Atelier is a server-side
   application), the same shape as sign-in with Authentik (ADR-0005). No token
   is shown to, copied by, or pasted by the person.

3. **Two scopes, one optional.**
   - **Pages Write** (required): create and delete the studio's Pages projects,
     upload, deploy, attach domains to a project.
   - **DNS Write** (optional): create the DNS record for a domain that is
     managed in the connected account. Cloudflare lets a client mark scopes
     optional, and the person may decline it on the consent screen. A studio
     that only wants hosting is never asked to hand over its DNS.

4. **The grant is a stored secret, per studio.** Access and refresh tokens are
   sealed like provider keys (AES-256-GCM, bound to the studio; ADR-0011),
   never returned by the API, never sent to a workspace. Connecting,
   reconnecting and disconnecting need `secrets.manage` and a recent sign-in,
   and are written to the activity record.

5. **Only the deployer talks to Cloudflare, still.** The control plane hands
   the deployer the studio's credential with each request (or the deployer
   fetches it by studio id over the control network; to be settled when
   building). The deployer keeps its checks: static files only, the `atl-`
   name prefix, no project code runs. The prefix matters more here, not less:
   in a studio's own account it is what keeps Atelier away from that studio's
   other Pages projects.

6. **Domains are set up for the person when they can be.** When a domain is
   added and the connected account manages its DNS (and DNS Write was granted),
   Atelier attaches the domain to the Pages project and creates the DNS record
   itself. The person types the domain name and nothing else. In every other
   case (DNS elsewhere, DNS Write declined, the shared account) the Address
   dialog shows the one record to add by hand, as it does now.

7. **Moving between accounts is explicit.** Connecting an account does not move
   websites that are already published. Each website says where it is hosted,
   and "move to my Cloudflare" publishes it in the new account, moves its
   domains, then removes it from the old one. Disconnecting is refused while
   websites are still hosted in that account, and says which.

8. **A fallback that needs no approval from Cloudflare.** Until the OAuth
   client is public (see below), or for a self-hosted instance that cannot
   register one, a studio can connect by token instead: a link that opens
   Cloudflare's token page with the right permissions already filled in, then
   one paste. It is the same stored secret afterwards.

## Consequences

- A studio owns its hosting: its own account, its own bill (usually none; Pages
  is free at this scale), its sites visible in its own dashboard.
- The operator stops being the host of record for other people's websites.
- Atelier holds a more powerful secret per studio than it does today,
  especially with DNS Write. A leak would let an attacker change a studio's
  DNS. This is why the scope is optional, the secret is sealed and confined to
  the deployer, and disconnecting revokes the grant at Cloudflare as well as
  deleting it here.
- Every hosting call gains a "which account?" and can fail in a new way: the
  studio revoked access at Cloudflare. That must surface as "reconnect
  Cloudflare", not as a failed publish with no cause.
- The deployer needs a credential per request instead of one at start-up.

## To confirm before building

These come from reading Cloudflare's documentation on 2026-10-10, not from
trying it.

1. **What a public OAuth client requires.** A new client is private: only
   members of the operator's own Cloudflare account can use it. Making it
   usable by any Cloudflare user needs, at least, verification of the domain
   shown on the consent screen. The full list of prerequisites, and how long
   approval takes, is not yet known. This decides the date more than the code
   does.
2. **Scope names.** Scope ids come from `GET /oauth/scopes`; they correspond to
   API token permission names. Confirm the exact ids for Pages Write and DNS
   Write, and that DNS Write can be marked optional.
3. **Token lifetime and refresh.** How long an access token lasts and how
   refresh works. A publish must not fail because a token expired mid-upload.
4. **Choosing the account.** How a person with several Cloudflare accounts
   picks one during consent, and how Atelier learns the account id.
5. **Whether attaching a domain creates the DNS record.** Cloudflare's
   dashboard does it; its API explicitly does not for at least one other
   product. Plan on creating the record ourselves and confirm for Pages.
6. **Whether the upload-token step of Direct Upload accepts an OAuth access
   token** the way it accepts an API token.
7. **Revocation.** The call that revokes a grant, so that Disconnect really
   disconnects.

## Alternatives rejected

- **Paste a token only.** Works today with no approval, but it is the
  experience this ADR exists to avoid. Kept as the fallback (8), not the
  design.
- **Keep one shared account for everyone.** Simple, and stays the default, but
  cannot be the only option for the reasons in Context.
- **Ask for DNS Write always.** Simpler to build and more "automatic", but asks
  every studio for far more than hosting needs.
- **Atelier manages DNS anywhere via each registrar's API.** A different
  integration per registrar, for little gain over "add this one record".

## Sources

- Cloudflare changelog, 2026-06-03, "Introducing self-managed OAuth clients".
- Cloudflare docs: "OAuth Applications on Cloudflare", "Create your OAuth
  client", "Authorizing an application", "API token template URLs".
