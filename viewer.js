import { getDocument, GlobalWorkerOptions, TextLayer } from './vendor/pdfjs/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['document-title','original','previous','next','page-number','page-count','zoom-out','zoom-in','zoom-value','fit','find-toggle','find-bar','find-input','find-submit','find-next','find-status','viewport','loading','loading-text','error','error-message','error-original','page','canvas','text-layer','page-status'].map(id => [id,$(id)]));
const params = new URLSearchParams(location.search);
if (params.get('embedded') === '1') document.body.classList.add('embedded');

let pdf = null;
let pageNumber = Math.max(1, Number.parseInt(params.get('page'), 10) || 1);
let currentScale = 1;
let scaleMode = 'fit';
let renderTask = null;
let textLayer = null;
let renderVersion = 0;
let documentUrl = null;
let findVersion = 0;
let findQuery = '';
let findPages = [];
let findIndex = -1;
const textCache = new Map();

function safeDocumentUrl(raw) {
  if (!raw || /[\\\u0000-\u001f]/.test(raw)) throw new Error('Choose a PDF from this research desk to open it here.');
  const base = new URL('.', location.href);
  const url = new URL(raw, base);
  const decodedPath = decodeURIComponent(url.pathname);
  if (url.origin !== location.origin || url.username || url.password || url.search || url.hash || !decodedPath.startsWith(decodeURIComponent(base.pathname) + 'documents/') || !/\.pdf$/i.test(decodedPath)) {
    throw new Error('This reader opens source PDFs included in this research desk.');
  }
  const tail = decodedPath.slice(decodeURIComponent(base.pathname).length);
  if (tail.split('/').some(part => part === '..' || part === '.') || tail.includes('\\')) throw new Error('The document path is not valid.');
  return url;
}

function notify(type, data = {}) {
  if (window.parent !== window) window.parent.postMessage({type, ...data}, location.origin);
}

function setBusy(message) {
  ui.loading.hidden = false;
  ui['loading-text'].textContent = message;
  ui.viewport.setAttribute('aria-busy', 'true');
}

function showError(message) {
  ui.loading.hidden = true;
  ui.error.hidden = false;
  ui.page.hidden = true;
  ui['error-message'].textContent = message;
  ui.viewport.setAttribute('aria-busy', 'false');
  ui['page-status'].textContent = 'Document could not be displayed.';
  notify('frd:error', {message});
}

function updateControls() {
  ui['page-number'].value = pageNumber;
  ui['page-count'].textContent = pdf.numPages.toLocaleString();
  ui.previous.disabled = pageNumber <= 1;
  ui.next.disabled = pageNumber >= pdf.numPages;
  ui['zoom-out'].disabled = currentScale <= .3;
  ui['zoom-in'].disabled = currentScale >= 3;
  ui['zoom-value'].textContent = scaleMode === 'fit' ? 'Fit' : Math.round(currentScale * 100) + '%';
}

function highlightQuery() {
  if (!findQuery) return;
  const lower = findQuery.toLocaleLowerCase();
  let first = true;
  for (const span of ui['text-layer'].querySelectorAll('span')) {
    if (span.textContent.toLocaleLowerCase().includes(lower)) {
      span.classList.add('find-hit');
      if (first) { span.classList.add('find-current'); first = false; }
    }
  }
}

async function renderPage(number, {scroll = true} = {}) {
  if (!pdf) return;
  const version = ++renderVersion;
  pageNumber = Math.max(1, Math.min(pdf.numPages, Math.trunc(number) || 1));
  updateControls();
  setBusy(`Opening page ${pageNumber}…`);
  ui.error.hidden = true;
  if (renderTask) { renderTask.cancel(); try { await renderTask.promise; } catch {} }
  if (version !== renderVersion) return;
  textLayer?.cancel();
  try {
    const page = await pdf.getPage(pageNumber);
    if (version !== renderVersion) return;
    const unitViewport = page.getViewport({scale:1});
    if (scaleMode === 'fit') {
      const style = getComputedStyle(ui.viewport);
      const availableWidth = ui.viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      currentScale = Math.max(.2, Math.min(1.9, availableWidth / unitViewport.width));
    }
    const viewport = page.getViewport({scale:currentScale});
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const outputScale = Math.min(dpr, Math.sqrt(20000000 / (viewport.width * viewport.height)));
    ui.canvas.width = Math.floor(viewport.width * outputScale);
    ui.canvas.height = Math.floor(viewport.height * outputScale);
    ui.canvas.style.width = `${viewport.width}px`;
    ui.canvas.style.height = `${viewport.height}px`;
    ui.page.style.width = `${viewport.width}px`;
    ui.page.style.height = `${viewport.height}px`;
    ui.page.style.setProperty('--total-scale-factor', currentScale * page.userUnit);
    ui.page.hidden = false;
    ui['text-layer'].replaceChildren();
    const context = ui.canvas.getContext('2d', {alpha:false});
    renderTask = page.render({canvasContext:context, viewport, transform:outputScale === 1 ? null : [outputScale,0,0,outputScale,0,0], background:'rgb(255,255,255)'});
    await renderTask.promise;
    if (version !== renderVersion) return;
    textLayer = new TextLayer({textContentSource:page.streamTextContent(), container:ui['text-layer'], viewport});
    try { await textLayer.render(); } catch (error) { if (error.name !== 'AbortException') console.warn('Text layer unavailable:',error.message); }
    if (version !== renderVersion) return;
    // Explicit dimensions also support browsers without CSS round().
    ui['text-layer'].style.width = `${viewport.width}px`;
    ui['text-layer'].style.height = `${viewport.height}px`;
    highlightQuery();
    ui.loading.hidden = true;
    ui.viewport.setAttribute('aria-busy','false');
    ui['page-status'].textContent = `Page ${pageNumber.toLocaleString()} of ${pdf.numPages.toLocaleString()} · ${ui['text-layer'].textContent.trim() ? 'Text selectable' : 'No selectable text'}`;
    if (scroll) ui.viewport.scrollTo({top:0,left:0,behavior:'instant'});
    const url = new URL(location.href);
    url.searchParams.set('page', pageNumber);
    history.replaceState(null,'',url);
    updateControls();
    notify('frd:page', {page:pageNumber,pages:pdf.numPages});
  } catch (error) {
    if (version !== renderVersion || error.name === 'RenderingCancelledException') return;
    showError('This page could not be rendered. Try another page or open the original PDF.');
    console.error(error);
  }
}

async function pageText(number) {
  if (!textCache.has(number)) {
    const page = await pdf.getPage(number);
    const text = await page.getTextContent();
    textCache.set(number, text.items.map(item => item.str || '').join(' ').replace(/\s+/g,' ').toLocaleLowerCase());
  }
  return textCache.get(number);
}

async function findDocument(event) {
  event?.preventDefault();
  const query = ui['find-input'].value.trim().replace(/\s+/g,' ');
  const version = ++findVersion;
  findQuery = query;
  findPages = [];
  findIndex = -1;
  ui['find-next'].disabled = true;
  ui['text-layer'].querySelectorAll('.find-hit').forEach(node => node.classList.remove('find-hit','find-current'));
  if (!query) {ui['find-status'].textContent = ''; return;}
  ui['find-submit'].disabled = true;
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      if (version !== findVersion) return;
      ui['find-status'].textContent = `Searching page ${number} of ${pdf.numPages}…`;
      const text = await pageText(number);
      if (version !== findVersion) return;
      if (text.includes(query.toLocaleLowerCase())) findPages.push(number);
      if (number % 10 === 0) await new Promise(resolve => setTimeout(resolve,0));
    }
    if (!findPages.length) {ui['find-status'].textContent = 'No matching text. Scanned pages may not be searchable.'; return;}
    findIndex = Math.max(0,findPages.findIndex(number => number >= pageNumber));
    ui['find-next'].disabled = findPages.length < 2;
    await goToFindResult();
  } catch {
    if (version === findVersion) ui['find-status'].textContent = 'Text search is unavailable for this document.';
  } finally {if (version === findVersion) ui['find-submit'].disabled = false;}
}

async function goToFindResult() {
  ui['find-status'].textContent = `Matching page ${findIndex + 1} of ${findPages.length}`;
  await renderPage(findPages[findIndex]);
  ui['text-layer'].querySelector('.find-current')?.scrollIntoView({block:'center',behavior:'instant'});
}

ui.previous.addEventListener('click',()=>renderPage(pageNumber-1));
ui.next.addEventListener('click',()=>renderPage(pageNumber+1));
ui['page-number'].addEventListener('change',()=>renderPage(Number(ui['page-number'].value)));
ui['page-number'].addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();renderPage(Number(ui['page-number'].value));ui['page-number'].blur();}});
ui['zoom-in'].addEventListener('click',()=>{scaleMode='manual';currentScale=Math.min(3,currentScale*1.2);renderPage(pageNumber,{scroll:false});});
ui['zoom-out'].addEventListener('click',()=>{scaleMode='manual';currentScale=Math.max(.3,currentScale/1.2);renderPage(pageNumber,{scroll:false});});
ui.fit.addEventListener('click',()=>{scaleMode='fit';renderPage(pageNumber,{scroll:false});});
ui['find-toggle'].addEventListener('click',()=>{const open=ui['find-bar'].hidden;ui['find-bar'].hidden=!open;ui['find-toggle'].setAttribute('aria-expanded',String(open));if(open)ui['find-input'].focus();});
ui['find-bar'].addEventListener('submit',findDocument);
ui['find-next'].addEventListener('click',()=>{if(findPages.length){findIndex=(findIndex+1)%findPages.length;goToFindResult();}});
ui['find-input'].addEventListener('input',()=>{++findVersion;findQuery='';ui['find-submit'].disabled=false;ui['find-next'].disabled=true;ui['find-status'].textContent='';ui['text-layer'].querySelectorAll('.find-hit').forEach(node=>node.classList.remove('find-hit','find-current'));});
document.addEventListener('keydown',event=>{
  const editable = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
  if (event.key==='Escape'&&!ui['find-bar'].hidden){ui['find-bar'].hidden=true;ui['find-toggle'].setAttribute('aria-expanded','false');ui['find-toggle'].focus();}
  if (!editable && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if(event.key==='ArrowRight'){event.preventDefault();renderPage(pageNumber+1);}
    if(event.key==='ArrowLeft'){event.preventDefault();renderPage(pageNumber-1);}
  }
});
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===window.parent&&event.data?.type==='frd:go-to-page'&&Number.isFinite(event.data.page))renderPage(event.data.page);});
let resizeTimer;
let lastWidth=ui.viewport.clientWidth;
new ResizeObserver(()=>{const width=ui.viewport.clientWidth;if(Math.abs(width-lastWidth)<2)return;lastWidth=width;clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(pdf&&scaleMode==='fit')renderPage(pageNumber,{scroll:false});},180);}).observe(ui.viewport);

async function openDocument() {
  try {
    documentUrl = safeDocumentUrl(params.get('file'));
    const filename = decodeURIComponent(documentUrl.pathname.split('/').pop()).replace(/\.pdf$/i,'');
    const dated = filename.match(/^(\d{4}-\d{2}-\d{2})_(.*)$/);
    const words = (dated ? dated[2] : filename).replace(/[_-]/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase()).replace(/\bPlc\b/g,'plc').replace(/\bKpi\b/g,'KPI').replace(/\bIpo\b/g,'IPO');
    const basename = (params.get('title') || (dated ? `${words} · ${dated[1]}` : words)).slice(0,240);
    ui['document-title'].textContent = basename;
    document.title = basename + ' · Fundamental Research Desk';
    for (const link of [ui.original,ui['error-original']]){link.href=documentUrl.href;link.hidden=false;}
    const loadingTask = getDocument({url:documentUrl.href,cMapUrl:new URL('./vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/pdfjs/wasm/',import.meta.url).href,isEvalSupported:false,enableXfa:false});
    loadingTask.onProgress = progress=>{if(progress.total>0)ui['loading-text'].textContent=`Opening source document · ${Math.min(100,Math.round(progress.loaded/progress.total*100))}%`;};
    pdf = await loadingTask.promise;
    ui['page-number'].max = pdf.numPages;
    for(const id of ['page-number','zoom-out','zoom-in','fit','find-toggle'])ui[id].disabled=false;
    await renderPage(pageNumber);
  } catch(error) {
    const message = documentUrl ? 'The source PDF could not be loaded. Open the original PDF or return to the research desk.' : error.message;
    ui['document-title'].textContent = 'Document reader';
    showError(message);
  }
}

openDocument();
