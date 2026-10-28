(() => {
  const $ = id => document.getElementById(id);
  $('yr').textContent = new Date().getFullYear();

  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
  const fmt = b => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB' : (b/1048576).toFixed(1) + ' MB';
  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');

  const MAX_FULL = 80 * 1048576;   // read whole file up to 80 MB
  const EDGE = 24 * 1048576;       // otherwise read first & last 24 MB (metadata lives there)

  /* AI generator names to look for inside Content Credentials / XMP / software tags.
     Plain "Google"/"Samsung" are excluded on purpose: phone cameras use those too. */
  const GENERATORS = [
    [/ChatGPT/i, 'ChatGPT (OpenAI)'], [/DALL[·\-\u00b7 ]?E\b/, 'DALL-E (OpenAI)'], [/\bSora\b/, 'Sora (OpenAI)'],
    [/GPT-?4o|gpt-image|GPT Image/i, 'OpenAI GPT image'], [/OpenAI/, 'OpenAI'],
    [/Adobe Firefly|\bFirefly\b/, 'Adobe Firefly'], [/Generative Fill|Generative Expand/, 'Adobe Generative Fill'],
    [/\bImagen\b/, 'Google Imagen'], [/\bGemini\b/, 'Google Gemini'], [/\bVeo\b/, 'Google Veo'], [/Nano ?Banana/i, 'Google Nano Banana'],
    [/Midjourney/i, 'Midjourney'], [/Stable ?Diffusion|\bSDXL\b|stability\.ai/i, 'Stable Diffusion'],
    [/Bing Image Creator|Microsoft Designer|Image Creator from Microsoft/i, 'Microsoft Designer / Bing'],
    [/Meta AI|Imagine with Meta/, 'Meta AI'], [/\bGrok\b|\bxAI\b/, 'Grok (xAI)'],
    [/\bRunway(ML)?\b/, 'Runway'], [/\bKling\b/, 'Kling AI'], [/Pika Labs|\bPika\b/, 'Pika'], [/Luma AI|Dream Machine/, 'Luma'],
    [/Leonardo\.?ai/i, 'Leonardo.ai'], [/\bIdeogram\b/i, 'Ideogram'], [/\bFLUX\b|Black Forest Labs/, 'FLUX'],
    [/NovelAI/i, 'NovelAI'], [/Seedream|Seedance/, 'ByteDance Seedream'], [/Canva AI|Magic Media/, 'Canva AI'],
    [/Hailuo|MiniMax/, 'Hailuo / MiniMax'],
    [/Galaxy AI|Generative Edit/, 'Samsung Galaxy AI edit'], [/Magic Editor/, 'Google Magic Editor'],
  ];
  const AI_SOFTWARE = /Firefly|DALL|Midjourney|Stable Diffusion|NovelAI|ComfyUI|Automatic1111|InvokeAI|Fooocus|\bImagen\b|\bGemini\b|Leonardo|Ideogram|Bing Image|Image Creator|Microsoft Designer|\bSora\b|\bRunway\b|\bKling\b|\bGrok\b/i;

  function findGenerator(text){
    for (const [re, name] of GENERATORS) if (re.test(text)) return name;
    return null;
  }

  /* ---------- file reading ---------- */
  async function readBytes(file){
    if (file.size <= MAX_FULL) return { parts: [new Uint8Array(await file.arrayBuffer())], partial: false };
    const head = new Uint8Array(await file.slice(0, EDGE).arrayBuffer());
    const tail = new Uint8Array(await file.slice(file.size - EDGE).arrayBuffer());
    return { parts: [head, tail], partial: true };
  }

  function detectType(b, file){
    const s = latin1.decode(b.subarray(0, 16));
    if (b[0] === 0xFF && b[1] === 0xD8) return 'jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return 'webp';
    if (s.slice(4, 8) === 'ftyp') {
      const brand = s.slice(8, 12);
      if (/heic|heix|mif1|msf1|hevc/.test(brand)) return 'heic';
      if (/avif|avis/.test(brand)) return 'avif';
      return 'video';
    }
    if (s.startsWith('GIF8')) return 'gif';
    if (/^video\//.test(file.type)) return 'video';
    return 'other';
  }

  /* JPEG: collect APP11 (C2PA/JUMBF) segments */
  function jpegApp11(b){
    const out = [];
    let i = 2;
    while (i < b.length - 4) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01 || m === 0xFF) { i += (m === 0xFF ? 1 : 2); continue; }
      if (m === 0xDA || m === 0xD9) break;               // start of scan / end
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m === 0xEB) out.push(b.subarray(i + 4, i + 2 + len));
      i += 2 + len;
    }
    return out;
  }

  /* PNG: collect text chunks and caBX (C2PA) */
  async function pngChunks(b){
    const texts = {}; const c2pa = [];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let i = 8;
    while (i + 8 <= b.length) {
      const len = dv.getUint32(i); const type = latin1.decode(b.subarray(i + 4, i + 8));
      const data = b.subarray(i + 8, i + 8 + len);
      if (type === 'tEXt') {
        const z = data.indexOf(0);
        texts[latin1.decode(data.subarray(0, z))] = latin1.decode(data.subarray(z + 1));
      } else if (type === 'iTXt') {
        const z = data.indexOf(0); const key = latin1.decode(data.subarray(0, z));
        const comp = data[z + 1];
        let p = z + 3; p = data.indexOf(0, p) + 1; p = data.indexOf(0, p) + 1;
        let body = data.subarray(p);
        if (comp === 1) body = await inflate(body);
        texts[key] = body ? utf8.decode(body) : '';
      } else if (type === 'zTXt') {
        const z = data.indexOf(0); const key = latin1.decode(data.subarray(0, z));
        const body = await inflate(data.subarray(z + 2));
        texts[key] = body ? latin1.decode(body) : '';
      } else if (type === 'caBX') c2pa.push(data);
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return { texts, c2pa };
  }
  async function inflate(bytes){
    try {
      if (!window.DecompressionStream) return null;
      const ds = new DecompressionStream('deflate');
      const out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(out);
    } catch { return null; }
  }

  /* Pull the region around a JUMBF/C2PA manifest for formats without a dedicated container we parse */
  function c2paRegionFromText(t){
    const j = t.indexOf('jumb'); const c = t.indexOf('c2pa');
    if (j < 0 || c < 0) return '';
    const start = Math.max(0, Math.min(j, c) - 2048);
    return t.slice(start, start + 600000);
  }

  function sourceType(text){
    const m = text.match(/digitalsourcetype\/([A-Za-z]+)/i) || text.match(/DigitalSourceType[^A-Za-z]{1,40}([A-Za-z]+Media|digitalCapture|minorHumanEdits|compositeCapture|composite[A-Za-z]*)/i);
    return m ? m[1] : null;
  }
  function classifySource(st){
    if (!st) return null;
    const s = st.toLowerCase();
    if (s === 'trainedalgorithmicmedia' || s === 'algorithmicmedia') return 'ai';
    if (s.includes('compositewithtrainedalgorithmicmedia') || s === 'compositesynthetic' || s.includes('algorithmicallyenhanced')) return 'aiEdit';
    if (s === 'digitalcapture' || s === 'computationalcapture' || s === 'negativefilm' || s === 'positivefilm' || s === 'print') return 'camera';
    return null;
  }

  const SOURCE_NAMES = {
    trainedalgorithmicmedia: 'Created by a trained AI model',
    algorithmicmedia: 'Created by an algorithm',
    compositewithtrainedalgorithmicmedia: 'Edited / combined with AI-generated content',
    compositesynthetic: 'Composite including synthetic elements',
    algorithmicallyenhanced: 'Enhanced by an algorithm',
    digitalcapture: 'Captured by a digital camera',
    computationalcapture: 'Captured by a phone camera (computational photography)',
  };

  /* ---------- main analysis ---------- */
  async function analyse(file){
    const sig = [];        // {k:'ai'|'aiEdit'|'camera'|'info'|'warn', s:'strong'|'medium'|'weak', t, d}
    const meta = {};
    const add = (k, s, t, d) => sig.push({ k, s, t, d });

    const { parts, partial } = await readBytes(file);
    const b = parts[0];
    const type = detectType(b, file);
    const text = parts.map(p => latin1.decode(p)).join('\n');
    const isVideo = type === 'video';

    /* 1. Content Credentials (C2PA) */
    let c2paText = '';
    if (type === 'jpeg') c2paText = jpegApp11(b).map(x => latin1.decode(x)).join('');
    let png = null;
    if (type === 'png') { png = await pngChunks(b); c2paText = png.c2pa.map(x => latin1.decode(x)).join(''); }
    if (!c2paText) c2paText = c2paRegionFromText(text);
    const hasC2pa = c2paText && /c2pa/.test(c2paText) && /jumb|c2pa\.claim|c2pa\.signature|c2pa\.actions/.test(c2paText);

    if (hasC2pa) {
      const st = sourceType(c2paText);
      const cls = classifySource(st);
      const gen = findGenerator(c2paText);
      const issuer = (c2paText.match(/(OpenAI|Adobe|Google|Microsoft|Samsung|Leica|Sony|Nikon|Canon|Truepic|Meta|TikTok|LinkedIn|Qualcomm)[A-Za-z ,.]{0,30}/) || [])[0];
      meta['Content Credentials'] = 'Present' + (issuer ? ` (issuer: ${issuer.trim()})` : '');
      if (st) meta['Declared source'] = SOURCE_NAMES[st.toLowerCase()] || st;
      if (gen) meta['Tool named in credentials'] = gen;

      if (cls === 'ai') add('ai', 'strong', `Content Credentials say: AI-generated${gen ? ' by ' + gen : ''}`, 'The file carries a Content Credentials (C2PA) label declaring it was created by a trained AI model. Use “Verify credentials officially” to check the digital signature.');
      else if (cls === 'aiEdit') add('aiEdit', 'strong', `Content Credentials say: edited with AI${gen ? ' (' + gen + ')' : ''}`, 'The label says this content combines real media with AI-generated parts.');
      else if (cls === 'camera') add('camera', 'strong', 'Content Credentials say: captured by a camera', `Capture label${issuer ? ' from ' + issuer.trim() : ''}. Strong evidence of a real photo or video – confirm the signature with the official verifier.`);
      else if (gen && !/Galaxy AI|Magic Editor/.test(gen)) add('ai', 'strong', `Content Credentials from ${gen}`, 'The Content Credentials name an AI generation tool.');
      else if (gen) add('aiEdit', 'medium', `Content Credentials mention ${gen}`, 'The label names an AI editing feature.');
      else add('info', 'medium', 'Content Credentials found', 'This file has a provenance label, but it does not declare AI use. Open it in the official verifier for full details.');
    }

    /* 2. XMP / IPTC metadata */
    const xmpM = text.match(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/);
    const xmp = xmpM ? xmpM[0] : '';
    if (xmp) {
      const st = sourceType(xmp);
      const cls = classifySource(st);
      if (st && !hasC2pa) meta['Declared source'] = SOURCE_NAMES[st.toLowerCase()] || st;
      const gen = findGenerator(xmp);
      if (cls === 'ai') add('ai', hasC2pa ? 'medium' : 'medium', 'AI label in metadata (IPTC Digital Source Type)', `Tagged as “${SOURCE_NAMES[st.toLowerCase()]}”${gen ? ' – ' + gen : ''}. Unsigned tags can be edited, so this is a strong hint rather than proof.`);
      else if (cls === 'aiEdit') add('aiEdit', 'medium', 'Metadata says: edited with AI', `Tagged as “${SOURCE_NAMES[st.toLowerCase()] || st}”.`);
      else if (cls === 'camera' && !hasC2pa) add('camera', 'weak', 'Metadata says: captured by a camera', 'Unsigned tag – supporting evidence only.');
      if (/Made with AI|AI[ -]generated|Generated (with|by) AI|AI Generated Content/i.test(xmp)) add('ai', 'medium', 'Metadata contains an “AI generated” label', 'A text label inside the file says it was made with AI.');
      if (!cls && gen && !hasC2pa) add('ai', 'medium', `Metadata mentions ${gen}`, 'The file\'s metadata names an AI generation tool.');
    }

    /* 3. Stable Diffusion & other generator settings */
    if (png) {
      const keys = Object.keys(png.texts);
      const all = keys.map(k => k + ': ' + png.texts[k]).join('\n');
      if (png.texts.parameters && /Steps:\s*\d+/.test(png.texts.parameters)) add('ai', 'strong', 'Stable Diffusion generation settings found', 'The image contains a prompt, sampler and step count (Automatic1111 / Forge / Fooocus format).');
      else if ((png.texts.prompt || png.texts.workflow) && /class_type|"nodes"/.test(all)) add('ai', 'strong', 'ComfyUI workflow found', 'The image contains a ComfyUI node workflow used to generate it.');
      else if (png.texts.invokeai_metadata || png.texts['sd-metadata'] || png.texts.Dream) add('ai', 'strong', 'InvokeAI / Stable Diffusion metadata found', 'The image contains AI generation settings.');
      else if (/NovelAI/i.test(png.texts.Software || '') || /"sampler"|"n_samples"/.test(png.texts.Comment || '')) add('ai', 'strong', 'NovelAI generation settings found', 'The image contains NovelAI metadata.');
      for (const k of keys.slice(0, 12)) meta['PNG text: ' + k] = png.texts[k].slice(0, 220) + (png.texts[k].length > 220 ? '…' : '');
    }
    if (!png && /Steps:\s*\d+,\s*Sampler:/.test(text)) add('ai', 'strong', 'Stable Diffusion generation settings found', 'A prompt with sampler and step count is embedded in the file.');

    /* 4. Camera / EXIF (images) */
    let exif = null;
    if (!isVideo && window.exifr) {
      try { exif = await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: false, iptc: true, icc: false, mergeOutput: true }); } catch {}
    }
    if (exif) {
      const make = exif.Make && !(exif.Model || '').toLowerCase().startsWith(String(exif.Make).toLowerCase().split(' ')[0]) ? exif.Make : null, model = exif.Model || (make ? null : exif.Make);
      if (make || model) meta['Camera'] = [make, model].filter(Boolean).join(' ');
      if (exif.LensModel) meta['Lens'] = exif.LensModel;
      if (exif.DateTimeOriginal) meta['Taken'] = new Date(exif.DateTimeOriginal).toLocaleString();
      const expo = [exif.FNumber && 'f/' + exif.FNumber, exif.ExposureTime && (exif.ExposureTime < 1 ? '1/' + Math.round(1 / exif.ExposureTime) : exif.ExposureTime) + 's', exif.ISO && 'ISO ' + exif.ISO].filter(Boolean).join(' · ');
      if (expo) meta['Exposure'] = expo;
      if (exif.Software) meta['Software'] = exif.Software;
      if (exif.latitude != null) meta['Location'] = 'GPS location is stored in this file ⚠️';
      if (exif.UserComment && typeof exif.UserComment === 'string' && /Steps:\s*\d+/.test(exif.UserComment) && !sig.some(s => /Stable Diffusion/.test(s.t))) add('ai', 'strong', 'Stable Diffusion generation settings found', 'Prompt and settings are stored in the EXIF comment.');

      if ((make || model) && (exif.DateTimeOriginal || expo)) {
        add('camera', 'medium', `Camera data: ${esc([make, model].filter(Boolean).join(' '))}`, `Includes ${[exif.DateTimeOriginal && 'capture time', expo && 'exposure settings', exif.LensModel && 'lens'].filter(Boolean).join(', ')}. Typical of a real photo, though metadata can be copied.`);
      } else if (make || model) {
        add('camera', 'weak', `Device named: ${esc([make, model].filter(Boolean).join(' '))}`, 'No capture time or exposure data, so this is weak evidence.');
      }
      if (exif.Software) {
        if (AI_SOFTWARE.test(exif.Software)) add('ai', 'medium', `Created with ${esc(exif.Software)}`, 'The “Software” field names an AI tool.');
        else add('info', 'weak', `Saved with ${esc(exif.Software)}`, 'Editing or export software. Normal for many real photos.');
      }
    }

    /* 5. Video container hints */
    if (isVideo) {
      if (/com\.apple\.quicktime\.(make|model)/.test(text)) { add('camera', 'medium', 'Recorded on an Apple device', 'The video contains iPhone/iPad camera metadata.'); meta['Device'] = 'Apple (QuickTime camera tags)'; }
      if (/com\.android\.(version|manufacturer|model)/.test(text)) { add('camera', 'medium', 'Recorded on an Android phone', 'The video contains Android camera metadata.'); meta['Device'] = 'Android phone'; }
      if (/GoPro|DJI|Insta360/i.test(text.slice(0, 2e6))) add('camera', 'weak', 'Action camera / drone signature found', 'The file mentions a camera brand.');
      const enc = text.match(/Lavf\d+\.\d+\.\d+/);
      if (enc) { meta['Encoder'] = enc[0] + ' (FFmpeg)'; add('info', 'weak', 'Re-encoded with FFmpeg', 'The video was processed by software after capture. Common for downloaded, edited and AI-generated videos.'); }
      const gen = !hasC2pa && findGenerator(text.slice(0, 4e6));
      if (gen && !/Galaxy AI|Magic Editor/.test(gen)) add('ai', 'weak', `Mentions ${gen}`, 'An AI tool name appears in the file data. Weak on its own.');
    }

    /* 6. Weak hints */
    const dims = await getDims(file, isVideo);
    if (dims) meta['Dimensions'] = `${dims.w} × ${dims.h}` + (dims.dur ? ` · ${dims.dur.toFixed(1)} s` : '');
    const AI_SIZES = ['1024x1024','1024x1536','1536x1024','1024x1792','1792x1024','832x1216','1216x832','896x1152','1152x896','768x1344','1344x768','2048x2048','1408x768','768x1408'];
    if (dims && !isVideo && AI_SIZES.includes(dims.w + 'x' + dims.h) && !sig.some(s => s.k === 'camera'))
      add('info', 'weak', 'Image size is common for AI generators', `${dims.w} × ${dims.h} is a default output size of several AI tools. A hint only – many real images share it.`);

    const hasAnyMeta = hasC2pa || xmp || (exif && Object.keys(exif).length > 3) || (png && Object.keys(png.texts).length);
    if (!isVideo && !hasAnyMeta) add('warn', 'weak', 'Metadata has been removed', 'This file carries almost no hidden information – typical of screenshots and images saved from social media or messaging apps.');
    if (partial) add('info', 'weak', 'Large file: checked the beginning and end', 'Metadata is normally stored there, so results are still reliable.');

    meta['File'] = `${type.toUpperCase()} · ${fmt(file.size)}`;
    return { sig, meta, verdict: decide(sig, isVideo), isVideo };
  }

  function decide(sig, isVideo){
    const has = (k, ...s) => sig.some(x => x.k === k && s.includes(x.s));
    const noun = isVideo ? 'video' : 'image';
    if (has('ai', 'strong')) return { c: 'v-ai', label: '🤖 AI-generated', sum: `This ${noun} contains clear evidence that it was created with AI.` };
    if (has('aiEdit', 'strong', 'medium')) return { c: 'v-edit', label: '✂️ AI-edited', sum: `This looks like real media that was changed with AI tools.` };
    if (has('ai', 'medium')) return { c: 'v-ai', label: '🤖 Likely AI-generated', sum: `The ${noun} is labelled as AI-made, but the label isn't digitally signed.` };
    if (has('camera', 'strong')) return { c: 'v-real', label: '📷 Camera original', sum: `A Content Credentials label says this ${noun} was captured by a camera, and no AI labels were found.` };
    if (has('camera', 'medium')) return { c: 'v-real', label: '📷 Likely real', sum: `Camera data was found and no AI labels. Good sign – but metadata can be copied, so it isn't proof.` };
    return { c: 'v-none', label: '❔ No AI labels found', sum: `We found no evidence either way. That doesn't mean it's real – labels are often removed when files are shared. Try to get the original file, or use a reverse image search.` };
  }

  function getDims(file, isVideo){
    return new Promise(res => {
      const url = URL.createObjectURL(file);
      const done = v => { URL.revokeObjectURL(url); res(v); };
      if (isVideo) {
        const v = document.createElement('video'); v.preload = 'metadata';
        v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight, dur: v.duration });
        v.onerror = () => done(null); v.src = url;
      } else {
        const im = new Image();
        im.onload = () => done({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => done(null); im.src = url;
      }
      setTimeout(() => done(null), 8000);
    });
  }

  /* ---------- UI ---------- */
  const ORDER = { strong: 0, medium: 1, weak: 2 };
  function render(card, file, r){
    const v = r.verdict;
    card.querySelector('.verdict').className = 'verdict ' + v.c;
    card.querySelector('.vlabel').textContent = v.label;
    card.querySelector('.vsum').textContent = v.sum;
    const sigs = [...r.sig].sort((a, b) => ORDER[a.s] - ORDER[b.s]);
    const ev = card.querySelector('.evidence');
    ev.innerHTML = `<h3>Evidence found (${sigs.length})</h3>` + (sigs.length ? sigs.map(s =>
      `<div class="sig ${s.k}"><span class="dot"></span><div><b>${s.t}<span class="tag">${s.s}</span></b><small>${s.d}</small></div></div>`).join('')
      : '<div class="sig warn"><span class="dot"></span><div><b>Nothing found</b><small>No AI labels, camera data or provenance information.</small></div></div>')
      + `<details><summary>Show file details</summary><table class="kv">${Object.entries(r.meta).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></details>`
      + `<div class="next"><a href="https://contentcredentials.org/verify" target="_blank" rel="noopener">Verify credentials officially ↗</a>${r.isVideo ? '' : '<a href="https://lens.google.com/" target="_blank" rel="noopener">Reverse search on Google Lens ↗</a><a href="https://tineye.com/" target="_blank" rel="noopener">Search on TinEye ↗</a>'}</div>`;
  }

  async function handle(files){
    for (const file of files) {
      const isVid = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
      const url = URL.createObjectURL(file);
      const card = document.createElement('div');
      card.className = 'res';
      card.innerHTML = `<div class="res-top"><div class="preview">${isVid ? `<video src="${url}" muted controls playsinline></video>` : `<img src="${url}" alt="">`}</div>
        <div class="verdict v-load"><span class="vlabel">Analysing…</span><div class="fname">${esc(file.name)}</div><p class="vsum">Reading hidden labels and metadata…</p></div></div>
        <div class="evidence"></div>`;
      $('results').prepend(card);
      try { render(card, file, await analyse(file)); }
      catch (e) {
        console.error(e);
        card.querySelector('.vlabel').textContent = 'Could not read file';
        card.querySelector('.vsum').textContent = 'This file type could not be analysed. Try a JPG, PNG, WebP, HEIC, MP4 or MOV file.';
      }
    }
  }

  const drop = $('drop'), input = $('file');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { handle([...input.files]); input.value = ''; });
  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => handle([...e.dataTransfer.files]));
  window.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])]; if (f.length) handle(f); });
})();
