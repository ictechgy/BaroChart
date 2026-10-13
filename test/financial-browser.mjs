import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {launchBrowser} from '../scripts/cdp.mjs';
const server=spawn(process.execPath,['scripts/serve.mjs'],{stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',code=>reject(Error('Server '+code)));});
let browser;const results=[];
try {
  for(const width of [1280,430]) {
    browser=await launchBrowser({width,height:1100,dpr:width===430?2:1});await browser.navigate('http://127.0.0.1:5173/examples/web/financial.html');
    const result=await browser.evaluate(`(async()=>{
      const end=performance.now()+10000;while(!window.financialExample&&performance.now()<end)await new Promise(r=>setTimeout(r,20));
      const e=window.financialExample;if(!e)throw Error('Financial example did not initialize');const checks=[],check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name);},$=id=>document.getElementById(id);
      check(e.fixture.matched===12&&e.fixture.gaps===8&&e.fixture.unmatched===4,'20 primary /12 exact matches /8 gaps /4 outside-reference');
      check(document.querySelectorAll('#aligned-values tr').length===20&&document.querySelectorAll('#aligned-values .gap').length===8,'table presents every real timestamp and gap');
      check(document.querySelectorAll('#calendar-anchors tr').length===3,'day/week/month/DST anchor examples visible');
      const expectedAnchors=['2026-09-06T04:00:00.000Z','2021-03-21T20:30:00.000Z','2023-10-01T04:00:00.000Z'];check([...document.querySelectorAll('#calendar-anchors tr')].every((r,i)=>r.children[2].textContent===expectedAnchors[i]),'independent UTC period anchor literals');
      for(const scale of ['log','percent','linear']){$('scale').value=scale;$('scale').dispatchEvent(new Event('change'));check(!e.chart.lastError&&e.model.panels[0].scale===scale,'actual control '+scale);}
      $('inverted').checked=true;$('inverted').dispatchEvent(new Event('change'));check(e.model.panels.every(p=>p.inverted),'all panels invert through real control');
      $('sample-drawing').click();$('save').click();const saved=$('drawing-document').value;check(JSON.parse(saved).drawings.length===1,'sample anchored drawing saved');
      $('undo').click();check(!e.model.drawings.items.length,'undo removes drawing');$('redo').click();check(e.chart.api.saveDrawings()===saved,'redo restores exact JSON');
      $('reload').click();check(e.chart.api.saveDrawings()===saved,'reload preserves exact raw anchors');
      $('scale').value='percent';$('scale').dispatchEvent(new Event('change'));$('inverted').checked=false;$('inverted').dispatchEvent(new Event('change'));
      let layout=e.chart.lastScene.layout,p=layout.panels[0];e.chart.controller.move(99,layout.x(1.4),p.y(110));e.chart.drawNow();
      check($('crosshair-summary').textContent.includes('10.00%')&&$('cursor-bar').children[0].textContent==='2026-02-06T15:00:00.000Z'&&$('cursor-bar').children[6].textContent==='102.60','cursor percent /nearest actual timestamp /foreign value literal');
      layout=e.chart.lastScene.layout;p=layout.panels[0];e.chart.controller.move(99,layout.x(4.1),p.y(110));e.chart.drawNow();check($('cursor-bar').children[6].textContent==='공백','no carry across unmatched foreign timestamp');
      check(document.documentElement.scrollWidth<=innerWidth,'no viewport overflow at '+innerWidth+'px');check(e.chart.lastScene.layout.panels.length===3,'three panels draw');
      const anchorRows=[...document.querySelectorAll('#calendar-anchors tr')].map(r=>r.textContent),rawSource=Array.from(e.model.store.columns.time.subarray(0,e.model.store.length));
      e.cleanup();check(!document.querySelector('#chart canvas')&&!e.model.store.listeners.size,'example cleanup releases chart/subscriptions');
      return {width:innerWidth,checks,anchorRows,rawSource,scope:'Actual Chrome controls and synthetic cursor; fixed literal reference, no real feed/physical mobile/accessibility certification.'};
    })()`);results.push(result);await browser.close();browser=null;
  }
  await writeFile('benchmarks/results/cycle5-financial-browser.json',JSON.stringify({results},null,2));console.log(JSON.stringify({passed:results.reduce((n,r)=>n+r.checks.length,0),widths:results.map(r=>r.width)}));
} finally {await browser?.close();server.kill();}
