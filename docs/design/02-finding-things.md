# 02 — Finding things

Part of the [interface design reference](README.md).

## The rule

A person finds what they need by looking where it would sensibly be, not by
remembering where we put it.

## Put an action on the thing it acts on

People read closeness as belonging. So:

- What changes a website's published state lives on that state. The **Live** status in the editor bar opens: Open the live website, Copy its address, Address and domains, Unpublish.
- What acts on one website lives on its card (**More**): open, visit, unpublish, archive, delete.
- What acts on one row lives in that row: **Remove** on a domain, **Disconnect** on a provider, **Withdraw** on an invitation.
- A setting sits next to what it sets. The daily limit is set on the Usage page, beside the number it limits.

Do not collect unrelated actions in one dialog because the dialog exists.

## Show state in words, everywhere the object appears

- A website says **Live** or **Not published** on its card and in the editor.
- A provider says **Connected** or **Not connected**; a domain says **Connected** or **Waiting for DNS**.
- A piece of wording says **Published** or **Not published yet**.
- Colour supports the word (green live, amber not-yet-public). Colour is never the only signal.

## More than one way in

If two sensible people would look in two different places, both places work.
Unpublish is on the Live status, on the website card and in the Address dialog.
Address and Settings are in the editor bar and in the account menu. Repeating
an action costs little; hiding it costs the feature.

## Nothing important is buried

Ask of every action: how many things must I open, and would each of them
suggest this is inside? An action behind a dialog behind an unlabelled button
does not exist as far as the person is concerned. The primary actions of a
screen are visible on that screen without opening anything.

## Say what a screen or list is

- A panel or tab starts with one line saying what it holds and what you can do there ("Every change your assistant makes is saved here. Choose one to go back to it.").
- A settings page says who and what it affects.
- Headings describe ("Studio settings"), they do not merely decorate.

## Small screens

Words are not optional on a phone.

1. Keep the one or two most important actions in the bar, labelled (Publish).
2. Move the rest into a menu where every item is words (the account menu holds Address and domains, Website settings, All websites).
3. Use the labelled bottom tabs for switching between the main areas.
4. Never solve a width problem by deleting labels and leaving icons.

## Navigation

- You can always tell where you are (the studio name, the website name, the highlighted section).
- You can always get back: a labelled way to the list of websites from the editor.
- Web addresses are real and shareable for every page a person might want to return to.
