import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../examples/web/drawing-groups.html',import.meta.url),'utf8');
const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
function rule(selector){const found=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(m=>m[1].trim()===selector);assert(found,selector);return Object.fromEntries(found[2].split(';').filter(Boolean).map(p=>p.split(':').map(x=>x.trim())));}
function luminance(hex){const a=hex.match(/\w\w/g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return a[0]*.2126+a[1]*.7152+a[2]*.0722;}
function contrast(a,b){const [lo,hi]=[luminance(a.slice(1)),luminance(b.slice(1))].sort((x,y)=>x-y);return(hi+.05)/(lo+.05);}
test('drawing demo owns normal button/input/preset-select foreground/background pair despite light panel inheritance',()=>{const r=rule('#drawing-controls button,#drawing-controls input[type=text],#drawing-controls select');assert.equal(r.color,'#d7e2f1');assert.equal(r.background,'#111d2e');assert(contrast(r.color,r.background)>12.9);assert(contrast('#111111','#111d2e')<1.12);});
test('enabled hover pair remains explicit and high contrast without altering disabled opacity',()=>{const r=rule('#drawing-controls button:hover:not(:disabled)');assert.equal(r.color,'#7ce8ca');assert.equal(r.background,'#18352f');assert(contrast(r.color,r.background)>8);assert(!css.includes('opacity:'));assert(!css.includes('outline:none'));});
test('demo guidance reflects scoped Chrome checks and remaining assistive-technology gap',()=>{assert(html.includes('Earlier style/delete focus flows were checked in Mac Chrome 155'));assert(html.includes('New visibility controls have modeled Node tests only'));assert(html.includes('duplication and style-preset controls have the same unrun actual-browser boundary'));assert(html.includes('0 / 0 overlaps the source; copies are unlocked and preserve hidden state'));assert(html.includes('real-browser and assistive-technology behavior remain unverified'));});
