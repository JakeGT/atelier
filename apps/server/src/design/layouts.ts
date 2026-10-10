// Layouts: ready-made sections of a page. Each is plain HTML using the kit's
// classes (assets/kit.css), so it takes its whole appearance from the website's
// look, and each already marks its wording as editable. The assistant places a
// section, replaces PAGE in the references with the page's name, saves the
// wording with those fields, and rewrites the sample words for the website.

export interface Layout {
    id: string;
    name: string;
    // What it is for, for the person choosing and for the assistant.
    description: string;
    // Where on a page it usually goes.
    place: "top" | "body" | "bottom";
    html: string;
}

// A neutral picture to stand in until one from the library is chosen.
export const PLACEHOLDER =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 600'%3E%3Crect width='800' height='600' fill='%23999' fill-opacity='.22'/%3E%3Cpath d='M0 600 800 0M0 0l800 600' stroke='%23999' stroke-opacity='.45' stroke-width='2'/%3E%3C/svg%3E";

export const LAYOUTS: Layout[] = [
    {
        id: "nav",
        name: "Name and menu",
        description: "The website's name and the links to its pages, across the top of every page.",
        place: "top",
        html: `<header class="k-nav">
  <div class="k-wrap">
    <a class="k-brand" href="index.html" data-content="page/shared#site_name">Okoro Ceramics</a>
    <nav aria-label="Pages">
      <ul data-content-list="page/shared#menu">
        <li><a data-item="label" data-item-href="link" href="index.html">Home</a></li>
      </ul>
    </nav>
  </div>
</header>`,
    },
    {
        id: "hero",
        name: "Opening, centred",
        description: "A large headline, a line beneath it and one or two buttons, centred. The first thing a visitor sees.",
        place: "top",
        html: `<section class="k-hero k-center">
  <div class="k-wrap k-stack">
    <span class="k-label" data-content="page/PAGE#hero_label">Handmade in Lagos</span>
    <h1 data-content="page/PAGE#headline">Pots made slowly, to be used every day</h1>
    <p class="k-lead" data-content="page/PAGE#intro">Thrown, glazed and fired in a small studio since 1998.</p>
    <div class="k-actions">
      <a class="k-btn" data-content="page/PAGE#button" data-content-href="page/PAGE#button_link" href="#contact">Visit the studio</a>
      <a class="k-btn k-btn-quiet" data-content="page/PAGE#second_button" data-content-href="page/PAGE#second_button_link" href="#work">See the work</a>
    </div>
  </div>
</section>`,
    },
    {
        id: "hero-picture",
        name: "Opening, with a picture",
        description: "A headline and introduction on one side and a large picture on the other.",
        place: "top",
        html: `<section class="k-hero k-hero-split">
  <div class="k-wrap">
    <div class="k-stack">
      <span class="k-label" data-content="page/PAGE#hero_label">Handmade in Lagos</span>
      <h1 data-content="page/PAGE#headline">Pots made slowly, to be used every day</h1>
      <p class="k-lead" data-content="page/PAGE#intro">Thrown, glazed and fired in a small studio since 1998.</p>
      <div class="k-actions">
        <a class="k-btn" data-content="page/PAGE#button" data-content-href="page/PAGE#button_link" href="#contact">Visit the studio</a>
      </div>
    </div>
    <img class="k-picture" data-content-image="page/PAGE#hero_picture" src="${PLACEHOLDER}" alt="">
  </div>
</section>`,
    },
    {
        id: "features",
        name: "Three things side by side",
        description: "A heading and a row of cards, each with a title and a few words: services, features, reasons.",
        place: "body",
        html: `<section class="k-section">
  <div class="k-wrap">
    <div class="k-head">
      <span class="k-label" data-content="page/PAGE#features_label">What we do</span>
      <h2 data-content="page/PAGE#features_heading">Three ways to work with us</h2>
    </div>
    <ul class="k-grid k-grid-3" data-content-list="page/PAGE#features">
      <li class="k-card k-stack">
        <h3 data-item="title">Throwing classes</h3>
        <p class="k-muted" data-item="text">Six weeks at the wheel, in groups of five.</p>
      </li>
    </ul>
  </div>
</section>`,
    },
    {
        id: "split",
        name: "Words beside a picture",
        description: "A heading and a few paragraphs next to a picture. Use the flipped version to alternate sides down a page.",
        place: "body",
        html: `<section class="k-section k-split">
  <div class="k-wrap">
    <img class="k-picture" data-content-image="page/PAGE#story_picture" src="${PLACEHOLDER}" alt="">
    <div class="k-stack">
      <span class="k-label" data-content="page/PAGE#story_label">Our story</span>
      <h2 data-content="page/PAGE#story_heading">A studio that started at a kitchen table</h2>
      <div class="k-stack" data-content-rich="page/PAGE#story"><p>What began as one wheel and a borrowed kiln is now a workshop of four.</p></div>
    </div>
  </div>
</section>`,
    },
    {
        id: "stats",
        name: "A few numbers",
        description: "Three or four large numbers, each with a line saying what it counts.",
        place: "body",
        html: `<section class="k-section k-surface">
  <div class="k-wrap">
    <ul class="k-grid k-grid-4" data-content-list="page/PAGE#numbers">
      <li class="k-stat"><strong data-item="number">27</strong><span data-item="what">years at the wheel</span></li>
    </ul>
  </div>
</section>`,
    },
    {
        id: "bars",
        name: "Bars that compare",
        description: "A small chart: a label, a bar whose length is a number from 0 to 100, and a note, for each thing compared.",
        place: "body",
        html: `<section class="k-section">
  <div class="k-wrap">
    <div class="k-head">
      <h2 data-content="page/PAGE#bars_heading">How a pot spends its time</h2>
    </div>
    <ul class="k-bars" data-content-list="page/PAGE#bars">
      <li class="k-bar">
        <strong data-item="label">Drying</strong>
        <span class="k-bar-track"><span class="k-bar-fill" data-item-percent="amount" style="width:70%"></span></span>
        <span class="k-muted" data-item="note">Two weeks</span>
      </li>
    </ul>
  </div>
</section>`,
    },
    {
        id: "quote",
        name: "Words from someone",
        description: "One quotation in large type with who said it: a customer, a review, a founder.",
        place: "body",
        html: `<section class="k-section k-quote k-center">
  <div class="k-wrap">
    <blockquote data-content="page/PAGE#quote">“The mug I reach for every morning. Nothing else feels right now.”</blockquote>
    <cite data-content="page/PAGE#quote_by">Amara, a customer since 2019</cite>
  </div>
</section>`,
    },
    {
        id: "gallery",
        name: "Pictures in a grid",
        description: "A heading and a grid of pictures from the library, each with a caption.",
        place: "body",
        html: `<section class="k-section" id="work">
  <div class="k-wrap">
    <div class="k-head">
      <h2 data-content="page/PAGE#gallery_heading">Recent work</h2>
    </div>
    <ul class="k-grid k-grid-3" data-content-list="page/PAGE#gallery">
      <li class="k-stack">
        <img class="k-picture" data-item-image="picture" src="${PLACEHOLDER}" alt="">
        <p class="k-muted" data-item="caption">Stoneware bowl, ash glaze</p>
      </li>
    </ul>
  </div>
</section>`,
    },
    {
        id: "pricing",
        name: "Prices",
        description: "Two or three options side by side, each with a name, a price, what it includes and a button.",
        place: "body",
        html: `<section class="k-section k-surface">
  <div class="k-wrap">
    <div class="k-head k-center">
      <h2 data-content="page/PAGE#prices_heading">Classes and prices</h2>
    </div>
    <ul class="k-grid k-grid-3" data-content-list="page/PAGE#prices">
      <li class="k-card k-stack">
        <h3 data-item="name">Taster evening</h3>
        <span class="k-price" data-item="price">£35</span>
        <p class="k-muted" data-item="includes">Two hours, all materials, one finished piece.</p>
        <a class="k-btn" data-item-href="link" href="#contact">Book</a>
      </li>
    </ul>
  </div>
</section>`,
    },
    {
        id: "faq",
        name: "Questions and answers",
        description: "A heading and a list of questions, each with its answer.",
        place: "body",
        html: `<section class="k-section">
  <div class="k-wrap">
    <div class="k-head">
      <h2 data-content="page/PAGE#questions_heading">Good to know</h2>
    </div>
    <ul class="k-faq" data-content-list="page/PAGE#questions">
      <li>
        <h3 data-item="question">Do I need any experience?</h3>
        <p class="k-muted" data-item="answer">None at all. Most people who come have never touched clay.</p>
      </li>
    </ul>
  </div>
</section>`,
    },
    {
        id: "band",
        name: "One thing to do",
        description: "A band of colour with a short line and one button: book, call, subscribe.",
        place: "body",
        html: `<section class="k-section k-band k-center">
  <div class="k-wrap k-stack">
    <h2 data-content="page/PAGE#band_heading">Come and make something</h2>
    <p class="k-lead" data-content="page/PAGE#band_text">The next six-week course starts in March.</p>
    <div class="k-actions">
      <a class="k-btn" data-content="page/PAGE#band_button" data-content-href="page/PAGE#band_button_link" href="#contact">Reserve a place</a>
    </div>
  </div>
</section>`,
    },
    {
        id: "contact",
        name: "Where and when",
        description: "How to reach you and when you are open, side by side.",
        place: "bottom",
        html: `<section class="k-section" id="contact">
  <div class="k-wrap">
   <div class="k-grid k-grid-2">
    <div class="k-stack">
      <h2 data-content="page/PAGE#contact_heading">Find us</h2>
      <div class="k-stack" data-content-rich="page/PAGE#contact_details"><p>14 Herbert Macaulay Way, Yaba, Lagos</p><p><a href="mailto:hello@example.com">hello@example.com</a></p></div>
    </div>
    <div class="k-stack">
      <h3 data-content="page/PAGE#hours_heading">Opening hours</h3>
      <ul class="k-list" data-content-list="page/PAGE#hours"><li>Tuesday to Saturday, 10 to 6</li></ul>
    </div>
   </div>
  </div>
</section>`,
    },
    {
        id: "foot",
        name: "Foot of the page",
        description: "A closing line and small print, at the bottom of every page.",
        place: "bottom",
        html: `<footer class="k-foot">
  <div class="k-wrap">
    <span data-content="page/shared#footer">Okoro Ceramics, Lagos</span>
    <span data-content="page/shared#small_print">Made with care.</span>
  </div>
</footer>`,
    },
];

export const findLayout = (id: string): Layout | undefined => LAYOUTS.find((l) => l.id === id);

// A whole page showing some sections, wearing whatever theme.css is beside it.
export function samplePage(title: string, sections: Layout[]): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="kit.css">
</head>
<body>
${sections.map((s) => s.html.replaceAll("page/PAGE#", "page/home#")).join("\n")}
</body>
</html>
`;
}

// What a look is shown with in the gallery: a short page that uses most of the kit.
export const SHOWCASE = ["nav", "hero-picture", "features", "quote", "band", "foot"];

// Wording that fills the sample pages, so lists show several entries as they would on a real website.
export const SAMPLE_CONTENT: { kind: string; slug: string; content: Record<string, unknown> }[] = [
    {
        kind: "page",
        slug: "shared",
        content: {
            site_name: "Okoro Ceramics",
            menu: [
                { label: "Work", link: "#work" },
                { label: "Classes", link: "#classes" },
                { label: "About", link: "#about" },
                { label: "Visit", link: "#contact" },
            ],
            footer: "Okoro Ceramics, Lagos",
            small_print: "Made with care.",
        },
    },
    {
        kind: "page",
        slug: "home",
        content: {
            features: [
                { title: "Throwing classes", text: "Six weeks at the wheel, in groups of five." },
                { title: "Commissions", text: "Dinner sets and one-off pieces, made to order." },
                { title: "Open studio", text: "Come and watch a firing on the first Saturday of the month." },
            ],
            numbers: [
                { number: "27", what: "years at the wheel" },
                { number: "4", what: "potters in the studio" },
                { number: "1,240°", what: "in the kiln" },
                { number: "0", what: "two pots the same" },
            ],
            bars: [
                { label: "Throwing", amount: 12, note: "An afternoon" },
                { label: "Drying", amount: 70, note: "Two weeks" },
                { label: "Firing", amount: 28, note: "Three days" },
                { label: "Glazing", amount: 18, note: "A day" },
            ],
            gallery: [{ caption: "Stoneware bowl, ash glaze" }, { caption: "Tall jug, tenmoku" }, { caption: "Breakfast set, celadon" }],
            prices: [
                { name: "Taster evening", price: "£35", includes: "Two hours, all materials, one finished piece.", link: "#contact" },
                { name: "Six-week course", price: "£180", includes: "A wheel of your own, glazes and two firings.", link: "#contact" },
                {
                    name: "Studio membership",
                    price: "£95 a month",
                    includes: "Come and go as you please, with a shelf and a key.",
                    link: "#contact",
                },
            ],
            questions: [
                { question: "Do I need any experience?", answer: "None at all. Most people who come have never touched clay." },
                { question: "What should I wear?", answer: "Something you do not mind getting muddy. We lend aprons." },
                { question: "When do I get my pots?", answer: "About three weeks after your last class, once they are glazed and fired." },
            ],
            hours: ["Tuesday to Friday, 10 to 6", "Saturday, 10 to 4", "Sunday and Monday, closed"],
        },
    },
];
