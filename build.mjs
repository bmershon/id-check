import * as esbuild from "esbuild";
import fs from "fs";
const r = await esbuild.build({ entryPoints:["src/app.js"], bundle:true, format:"iife", minify:true, write:false, target:["safari15","chrome100"], loader:{".b64":"text"}, logLevel:"warning" });
let js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = fs.readFileSync("src/shell.html","utf8").replace("<!--APP-->", ()=>`<script>${js}</script>`);
fs.writeFileSync("index.html", html);
console.log("size", (html.length/1e6).toFixed(2), "MB");
