// Reads the 12-digit InstaPay reference from a receipt screenshot, in the browser.
// Tesseract (self-hosted in /vendor/ocr) loads only when a customer picks a screenshot.
let workerP = null;

async function worker() {
  if (!workerP) {
    workerP = (async () => {
      const mod = await import('/vendor/ocr/tesseract.esm.min.js');
      const createWorker = mod.createWorker || mod.default?.createWorker;
      return createWorker('eng', 1, {
        workerPath: '/vendor/ocr/worker.min.js',
        corePath: '/vendor/ocr/',
        langPath: '/vendor/ocr/',
        workerBlobURL: false,
        gzip: true,
      });
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

// Shrink very large photos first (faster, same accuracy for screen text)
async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 4e6) { bmp.close?.(); return file; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

/** → { ok: true, reference, amount? } | { ok: false, reason: 'no_reference' | 'unavailable' } */
export async function readReference(file) {
  let text;
  try {
    const w = await worker();
    const { data } = await w.recognize(await prepare(file));
    text = data.text || '';
  } catch (e) {
    console.warn('OCR unavailable', e);
    return { ok: false, reason: 'unavailable' };
  }
  const flat = text.replace(/[ \t]/g, '');
  const all = [...new Set([...flat.matchAll(/(?:^|\D)(\d{12})(?!\d)/g)].map((m) => m[1]))];   // no look-behind: older iPhones
  if (!all.length) return { ok: false, reason: 'no_reference', text };
  // prefer the number written next to "Reference"
  const near = flat.match(/(?:Reference|Ref\.?|مرجع\S*)[^\d\n]{0,20}(\d{12})(?!\d)/i);
  return { ok: true, reference: near ? near[1] : all[0], candidates: all, text };
}
