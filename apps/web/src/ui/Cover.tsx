import { useState } from "react";

// A generated cover for a project: the same id always draws the same composition.
// Four layouts × six palettes, picked from a hash, so a grid of projects looks
// like a wall of studies rather than a list of grey boxes.

const PALETTES: [string, string, string][] = [
    ["#e9dcc6", "#dc4326", "#17150f"], // paper / seal / ink
    ["#1f3a34", "#e8c27a", "#f3efe4"], // pine / brass / cream
    ["#d9d4ea", "#3b2f7a", "#17150f"], // lilac / indigo / ink
    ["#f1c9b4", "#1d4e6b", "#17150f"], // clay / teal / ink
    ["#22201b", "#dc4326", "#f3efe4"], // night / seal / cream
    ["#cfdccb", "#2f5d3a", "#17150f"], // sage / moss / ink
];

function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// `src`: a picture of the website's home page, when one has been taken. Until then (a website
// with no page yet), and if the picture cannot be fetched, the drawn cover stands in.
export function Cover({ seed, label, src }: { seed: string; label: string; src?: string }) {
    const [failed, setFailed] = useState<string | null>(null);
    if (src && failed !== src)
        return <img className="cover cover-picture" src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(src)} />;
    return <Drawn seed={seed} label={label} />;
}

function Drawn({ seed, label }: { seed: string; label: string }) {
    const h = hash(seed);
    const [bg, accent, ink] = PALETTES[h % PALETTES.length] ?? PALETTES[0];
    const layout = (h >>> 4) % 4;
    const shift = ((h >>> 8) % 40) - 20;
    // The first whole character: a name may begin with one that takes two places (an emoji, say).
    const initial = Array.from(label.trim())[0]?.toUpperCase() ?? "A";

    return (
        <svg className="cover" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <rect width="320" height="200" fill={bg} />
            {layout === 0 && (
                <>
                    <circle cx={222 + shift} cy="92" r="74" fill={accent} />
                    <rect x="0" y="176" width="320" height="24" fill={accent} opacity="0.55" />
                </>
            )}
            {layout === 1 && (
                <>
                    <path d={`M${60 + shift} 200 V110 a70 70 0 0 1 140 0 V200 Z`} fill={accent} />
                    <circle cx={250 + shift / 2} cy="56" r="22" fill={ink} />
                </>
            )}
            {layout === 2 && (
                <>
                    <rect x={170 + shift} y="0" width="200" height="200" fill={accent} />
                    <rect x={170 + shift} y="120" width="200" height="80" fill={ink} opacity="0.88" />
                    <circle cx={170 + shift} cy="120" r="44" fill={bg} />
                </>
            )}
            {layout === 3 &&
                [0, 1, 2, 3, 4].map((i) => (
                    <rect key={i} x={150 + i * 34 + shift} y={30 + i * 22} width="20" height={170 - i * 22} fill={i % 2 ? ink : accent} />
                ))}
            <text x="26" y="172" fontFamily="'Instrument Serif', Georgia, serif" fontStyle="italic" fontSize="150" fill={ink}>
                {initial}
            </text>
        </svg>
    );
}
