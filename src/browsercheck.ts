// Live browser check: read → click → read, type → read, staleness, tabs. Needs Chrome/Edge
// installed (or ADA_BROWSER set). Run with: npm run check:browser
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { browserAction, tabAction } from "./client/browser.ts";

const page = `<!doctype html><title>check</title>
<button onclick="document.getElementById('out').textContent='clicked'">Do thing</button>
<input aria-label="Name">
<div id="out"></div>`;

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
