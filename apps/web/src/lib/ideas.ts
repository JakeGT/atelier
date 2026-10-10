// Ready-made requests: things people often want, worded so the assistant does
// them well. Choosing one puts it in the message box to change or send as it is.
export interface Idea {
    name: string;
    request: string;
}

export const IDEAS: Idea[] = [
    {
        name: "Add a contact section",
        request:
            "Add a contact section at the bottom of the home page with my e-mail address, phone number and where to find me. Use placeholders I can replace, and save them as wording I can edit.",
    },
    {
        name: "Add an About page",
        request:
            "Add an About page that matches the rest of the website, with a short introduction and a photo placeholder, and link to it from the navigation on every page.",
    },
    {
        name: "Add opening hours",
        request: "Add opening hours to the home page as a clear list of days and times, and save them as wording I can edit myself.",
    },
    {
        name: "Add questions and answers",
        request:
            "Add a section of five common questions and short answers that suit this website. Write real, specific answers, not filler.",
    },
    {
        name: "Add a price list",
        request:
            "Add a simple, easy-to-read price list with three or four items, each with a name, a one-line description and a price I can change.",
    },
    {
        name: "Make it work better on a phone",
        request:
            "Check every page at phone width. Fix anything that overflows, is too small to tap or read, or leaves awkward gaps, without changing how it looks on a computer.",
    },
    {
        name: "Improve it for search engines",
        request:
            "Give every page a clear title and description, make sure headings are in a sensible order, and add descriptions to images. Tell me what you changed.",
    },
    {
        name: "Check the writing",
        request:
            "Read all the wording for spelling, grammar and a consistent tone. Fix mistakes and tell me about anything you were unsure of, without rewriting my style.",
    },
    {
        name: "Try a different look",
        request:
            "Suggest a different colour scheme and typeface that would suit this website, apply it everywhere, and tell me what you chose so I can ask for it to be undone.",
    },
];
