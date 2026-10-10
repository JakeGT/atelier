import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { siteFromArchive } from "../src/runtime/pages.ts";
import { fillHtml, lookupFrom } from "../src/services/fill.ts";
import { MediaError, mediaName, prepareUpload, sanitizeSvg, sniff } from "../src/services/media.ts";
import { DiskStorage, MemoryStorage, R2Storage, signV4 } from "../src/services/mediaStorage.ts";

const T = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";

test("request signing matches Amazon's published examples", () => {
    const common = {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/"),
        region: "us-east-1",
    };
    const get = signV4({
        ...common,
        method: "GET",
        path: "/test.txt",
        headers: {
            host: "examplebucket.s3.amazonaws.com",
            range: "bytes=0-9",
            "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "x-amz-date": "20130524T000000Z",
        },
    });
    assert.ok(get.endsWith("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"));
    const put = signV4({
        ...common,
        method: "PUT",
        path: "/test%24file.text",
        headers: {
            date: "Fri, 24 May 2013 00:00:00 GMT",
            host: "examplebucket.s3.amazonaws.com",
            "x-amz-content-sha256": "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
            "x-amz-date": "20130524T000000Z",
            "x-amz-storage-class": "REDUCED_REDUNDANCY",
        },
    });
    assert.ok(put.endsWith("Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"));
});

test("R2 storage: signed requests to the bucket's path; missing is null; keys are confined", async () => {
    const seen: { method: string; url: string; auth: string }[] = [];
    const objects = new Map<string, Uint8Array>();
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? "GET";
        seen.push({ method, url: u, auth: new Headers(init?.headers).get("authorization") ?? "" });
        if (method === "PUT") objects.set(u, init?.body as Uint8Array);
        if (method === "DELETE") objects.delete(u);
        if (method === "GET")
            return objects.has(u) ? new Response(objects.get(u) as Uint8Array<ArrayBuffer>) : new Response("", { status: 404 });
        return new Response("");
    }) as typeof fetch;
    const r2 = new R2Storage({ accountId: "acct", bucket: "atelier-media", accessKeyId: "id", secretAccessKey: "s", fetch: fake });
    const key = `${T}/${P}/photo-abc123.jpg`;
    await r2.put(key, new Uint8Array([1, 2, 3]), "image/jpeg");
    assert.equal(seen[0]?.url, `https://acct.r2.cloudflarestorage.com/atelier-media/${key}`);
    assert.match(
        seen[0]?.auth ?? "",
        /^AWS4-HMAC-SHA256 Credential=id\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    assert.deepEqual([...((await r2.get(key)) ?? [])], [1, 2, 3]);
    await r2.delete(key);
    assert.equal(await r2.get(key), null);
    for (const bad of ["../x", `${T}/../${P}/a.jpg`, `${T}/${P}/../../etc`, "a/b/c.jpg"])
        await assert.rejects(r2.put(bad, new Uint8Array(), "x"), /invalid media key/);
    const disk = new DiskStorage("/tmp/atelier-media-test");
    await assert.rejects(disk.put(`${T}/${P}/..`, new Uint8Array(), "x"), /invalid media key/);
    await disk.put(key, new Uint8Array([9]), "image/jpeg");
    assert.deepEqual([...((await disk.get(key)) ?? [])], [9]);
    await disk.delete(key);
    assert.equal(await disk.get(key), null);
    assert.equal(new MemoryStorage().kind, "memory");
});

test("what a file is comes from its bytes, not its name", async () => {
    assert.equal(sniff(new TextEncoder().encode("<html><script>alert(1)</script></html>")), null);
    assert.equal(sniff(new TextEncoder().encode("MZ\x90\x00 an executable, renamed"))?.mime, undefined);
    assert.equal(sniff(new TextEncoder().encode("%PDF-1.7 and more bytes"))?.kind, "document");
    await assert.rejects(prepareUpload("holiday.jpg", new TextEncoder().encode("<html>not a photo at all</html>")), MediaError);
    assert.match(mediaName("Summer Fête (final).JPG", "jpg"), /^summer-fete-final-[0-9a-f]{6}\.jpg$/);
    assert.match(mediaName("../../etc/passwd", "png"), /^passwd-[0-9a-f]{6}\.png$/);
    assert.match(mediaName("???", "png"), /^file-[0-9a-f]{6}\.png$/);
});

test("a photograph is turned upright, capped, stripped of camera data, and given smaller copies", async () => {
    const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#c63" } })
        .jpeg()
        .withExif({ IFD0: { Copyright: "taken at home" }, IFD3: { GPSLatitudeRef: "N" } })
        .toBuffer();
    assert.ok((await sharp(photo).metadata()).exif, "the test photograph carries camera data");
    const p = await prepareUpload("Shop front.JPG", photo);
    assert.equal(p.kind, "image");
    assert.deepEqual([p.width, p.height], [2560, 1920]);
    assert.equal((await sharp(p.main.body).metadata()).exif, undefined);
    assert.deepEqual(
        p.variants.map((v) => v.width),
        [480, 960, 1600],
    );
    assert.ok(p.variants.every((v) => v.name.endsWith(`-${v.width}.webp`) && v.body.length < p.main.body.length));
    // A small image is not enlarged and gets no pointless copies.
    const small = await prepareUpload(
        "icon.png",
        await sharp({ create: { width: 300, height: 300, channels: 4, background: "#000" } })
            .png()
            .toBuffer(),
    );
    assert.deepEqual([small.width, small.variants.length], [300, 0]);
});

test("an SVG is reduced to drawing", () => {
    const out = sanitizeSvg(
        `<?xml version="1.0"?><svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)"><circle r="4" fill="url(#g)" style="background:url(https://evil.test/x)" onclick="x()"/></a><foreignObject><iframe src="x"></iframe></foreignObject><use href="https://evil.test/x.svg#a"/><use xlink:href="#ok"/><image href="https://evil.test/p.png"/><linearGradient id="g"><stop offset="0"/></linearGradient><style>@import url(https://evil.test)</style></svg>`,
    );
    for (const gone of ["script", "onload", "onclick", "javascript", "foreignObject", "iframe", "evil.test", "<image", "<style", "@import"])
        assert.ok(!out.includes(gone), gone);
    assert.match(out, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 10 10">/);
    assert.match(out, /<circle r="4" fill="url\(#g\)"><\/circle>/);
    assert.match(out, /<use xlink:href="#ok"><\/use>/);
    assert.match(out, /<linearGradient id="g">/);
    assert.throws(() => sanitizeSvg("<p>not a drawing</p>"), MediaError);
});

test("a bound image shows the library file, with its description and sizes", () => {
    const page = `<!doctype html><html><head></head><body><img data-content-image="page/home#photo" src="old.jpg" alt="old" class="hero"><img src="media/untouched.jpg"></body></html>`;
    const lookup = lookupFrom([{ kind: "page", slug: "home", content: { photo: "media/shop-abc123.jpg" } }]);
    const media = (n: string) =>
        n === "shop-abc123.jpg"
            ? { name: n, alt: 'The "shop" <front>', width: 2000, height: 1000, variants: [{ name: "shop-abc123-480.webp", width: 480 }] }
            : undefined;
    const out = fillHtml(page, lookup, { media, base: "../" });
    assert.match(
        out,
        /<img data-content-image="page\/home#photo" src="\.\.\/media\/shop-abc123\.jpg" alt="The &quot;shop&quot; <front>" class="hero" width="2000" height="1000" srcset="\.\.\/media\/shop-abc123-480\.webp 480w, \.\.\/media\/shop-abc123\.jpg 2000w" sizes="100vw">/,
    );
    assert.match(out, /<img src="media\/untouched\.jpg">/);
    // Only a library path is ever placed: nothing else a field holds can become an address.
    for (const bad of ["javascript:alert(1)", "https://evil.test/x.png", "media/../secret.png", "media/a b.png", 7]) {
        const kept = fillHtml(page, lookupFrom([{ kind: "page", slug: "home", content: { photo: bad } }]), { media });
        assert.match(kept, /src="old\.jpg" alt="old"/);
    }
});

test("library files a release uses are published under /media/; a website's own file at that address wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "atelier-media-"));
    mkdirSync(join(dir, "media"));
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(dir, "media/own.png"), "the website's own");
    const archive = execFileSync("tar", ["-cf", "-", "index.html", "media/own.png"], { cwd: dir });
    const site = siteFromArchive(archive, undefined, undefined, [
        { name: "photo-abc123.jpg", body: Buffer.from("jpeg bytes") },
        { name: "own.png", body: Buffer.from("from the library") },
        { name: "../escape.png", body: Buffer.from("x") },
    ]);
    const paths = site.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["/404.html", "/index.html", "/media/own.png", "/media/photo-abc123.jpg"]);
    assert.equal(site.files.find((f) => f.path === "/media/own.png")?.body.toString(), "the website's own");
    assert.equal(site.files.find((f) => f.path === "/media/photo-abc123.jpg")?.contentType, "image/jpeg");
});

test("configuration: R2 needs all four values; a bucket alone is refused clearly; none means the library is off", async () => {
    const { loadConfig } = await import("../src/config.ts");
    const base = { AUTH_MODE: "off", PUBLIC_ORIGIN: "http://localhost:8080" };
    assert.equal(loadConfig(base).mediaStorage, "off");
    assert.equal(loadConfig(base).r2, null);
    assert.throws(() => loadConfig({ ...base, R2_BUCKET: "atelier-media" }), /MEDIA_STORAGE=r2 requires/);
    const on = loadConfig({
        ...base,
        R2_BUCKET: "b",
        R2_ACCOUNT_ID: "a",
        R2_ACCESS_KEY_ID: "k",
        R2_SECRET_ACCESS_KEY: "s",
        R2_ENDPOINT: "https://a.eu.r2.cloudflarestorage.com",
    });
    assert.equal(on.mediaStorage, "r2");
    assert.equal(on.r2?.endpoint, "https://a.eu.r2.cloudflarestorage.com");
    assert.throws(() => loadConfig({ ...base, RESEND_API_KEY: "k" }), /requires MAIL_FROM/);
});
