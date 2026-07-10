#!/usr/bin/env bun
// Bootstrap a fresh Synapse test server and print the context as JSON — for
// E2E harnesses that need the tokens outside the test process.
//   bun bootstrap-cli.ts <url>     (or MX_IT_URL)
import { bootstrap } from "./bootstrap.ts";

const url = process.argv[2] ?? process.env.MX_IT_URL;
if (!url) {
  console.error("usage: bun bootstrap-cli.ts <url>");
  process.exit(1);
}
console.log(JSON.stringify(await bootstrap(url), null, 2));
