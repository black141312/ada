// Live browser check: read → click → read, type → read, staleness, tabs. Needs Chrome/Edge
// installed (or ADA_BROWSER set). Run with: npm run check:browser
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { browserAction, tabAction } from "./client/browser.ts";

const page = `<!doctype html><title>check</title>
<button onclick="document.getElementById('out').textContent='clicked'">Do thing</button>
<input aria-label="Name">
<input id="email">
<select id="plan"><option value="a">Alpha</option><option value="b">Beta</option></select>
<div id="out"></div>
<div id="later"></div>
<script>setTimeout(() => { document.getElementById("later").textContent = "arrived late"; }, 800);</script>
<script>
  addEventListener("mousedown", (e) => { document.getElementById("out").textContent = e.clientX + "," + e.clientY; });
  addEventListener("keydown", (e) => { document.getElementById("out").textContent = "key=" + e.key; });
</script>`;

async function main(): Promise<void> {
  const srv = createServer((_, res) => {
    res.setHeader("content-type", "text/html");
    res.end(page);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  try {
    await browserAction("open", { url });
    let r = await browserAction("read", {});
    const btn = /button "Do thing" \[(ref_\d+)\]/.exec(r.text)?.[1];
    assert.ok(btn, `no button ref in tree:\n${r.text}`);

    // click mutates the DOM the way the click implies
    await browserAction("click", { ref: btn });
    r = await browserAction("read", {});
    assert.ok(r.text.includes("clicked"), `click did not land:\n${r.text}`);

    // type lands in the input's value
    const input = /textbox "Name"[^[]*\[(ref_\d+)\]/.exec(r.text)?.[1];
    assert.ok(input, `no input ref in tree:\n${r.text}`);
    await browserAction("type", { ref: input, text: "hello" });
    r = await browserAction("read", {});
    assert.ok(r.text.includes("hello"), `typed text did not land:\n${r.text}`);

    // acting after navigation fails with a read-again error
    await browserAction("open", { url });
    const stale = await browserAction("click", { ref: input }).then(
      () => "",
      (e) => String(e),
    );
    assert.ok(/`read`/.test(stale), `stale ref should demand a read, got: ${stale || "(no error)"}`);

    // coordinate click + character keys reach the page as real input events
    await browserAction("open", { url });
    await browserAction("click", { x: 200, y: 150 });
    r = await browserAction("read", {});
    assert.ok(r.text.includes("200,150"), `coordinate click did not land:\n${r.text}`);
    await browserAction("press", { key: "w" });
    r = await browserAction("read", {});
    assert.ok(r.text.includes("key=w"), `character key did not land:\n${r.text}`);
    await browserAction("press", { key: "space", hold: 300 }); // held key must not throw
    const shot = await browserAction("screenshot", {});
    assert.ok(shot.screenshot && shot.screenshot.length > 1024, "screenshot too small to be a real PNG");

    // targeting without a `read` first: CSS selector and visible text both reach the element
    await browserAction("open", { url });
    await browserAction("click", { find: "Do thing" });
    let body = await browserAction("eval", { expression: "document.getElementById('out').textContent" });
    assert.ok(body.text.includes("clicked"), `find-by-text click did not land:\n${body.text}`);
    await browserAction("type", { selector: "#email", text: "a@b.c" });
    body = await browserAction("eval", { expression: "document.getElementById('email').value" });
    assert.ok(body.text.includes("a@b.c"), `selector type did not land:\n${body.text}`);

    // fill writes through the native setter (what React listens to), select matches by label
    await browserAction("fill", { fields: { "#email": "filled@example.com" } });
    body = await browserAction("eval", { expression: "document.getElementById('email').value" });
    assert.ok(body.text.includes("filled@example.com"), `fill did not land:\n${body.text}`);
    await browserAction("select", { selector: "#plan", value: "Beta" });
    body = await browserAction("eval", { expression: "document.getElementById('plan').value" });
    assert.ok(body.text.includes("b"), `select did not land:\n${body.text}`);

    // wait blocks for content that shows up after load, and reports a timeout otherwise
    await browserAction("open", { url });
    const waited = await browserAction("wait", { find: "arrived late", timeout: 5000 });
    assert.ok(/after \d+ms/.test(waited.text), waited.text);
    const timedOut = await browserAction("wait", { selector: "#nope", timeout: 600 }).then(
      () => "",
      (e) => String(e),
    );
    assert.ok(/timed out/.test(timedOut), `wait should time out, got: ${timedOut || "(no error)"}`);

    // hover, reload and pdf must all survive a round trip
    await browserAction("hover", { find: "Do thing" });
    await browserAction("reload", {});
    const pdf = await browserAction("pdf", {});
    assert.ok(pdf.pdf && pdf.pdf.subarray(0, 4).toString() === "%PDF", "pdf output is not a PDF");

    // tabs: list shows origins, new adds one, close removes it
    const before = (await tabAction("tabs")).split("\n").length;
    const id = (await tabAction("tab_new")).replace("opened tab ", "");
    const listed = await tabAction("tabs");
    assert.ok(listed.split("\n").length === before + 1, listed);
    assert.ok(!listed.includes("check"), "tab list must not show page titles");
    await tabAction("tab_close", id);
    assert.equal((await tabAction("tabs")).split("\n").length, before);

    console.log("browser check: ok");
  } finally {
    srv.close();
    srv.closeAllConnections();
  }
}

await main();
