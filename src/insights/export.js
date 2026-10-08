// Export (Phase 5): the user picks what to export and a format; the file is built in the browser from data
// already loaded for the signed-in user (RLS decided what that is), so there is no export URL anyone could
// guess. PDF and Word libraries load only when those formats are used. No AI is involved.
import { fmtClock } from '../lib/segments.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const FORMATS = {
  pdf: { label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
  docx: { label: 'Word (.docx)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  md: { label: 'Markdown', ext: 'md', mime: 'text/markdown;charset=utf-8' },
  txt: { label: 'Text (.txt)', ext: 'txt', mime: 'text/plain;charset=utf-8' },
  srt: { label: 'Subtitles (.srt)', ext: 'srt', mime: 'application/x-subrip;charset=utf-8', subtitles: true },
  vtt: { label: 'Subtitles (.vtt)', ext: 'vtt', mime: 'text/vtt;charset=utf-8', subtitles: true },
};

// "Biology Lecture 8" + "Study Guide" -> "Biology-Lecture-8-Study-Guide"
export function fileBase(...parts) {
  const s = parts.filter(Boolean).join(' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90).replace(/-+$/, '');
  return s || 'SparkScribe-export';
}

// ---------- document -> formats ----------
// doc = { title, meta: [lines], sections: [{ heading, blocks: [{ t: 'h'|'p'|'li'|'quote'|'meta'|'pre', text, time? }] }] }
const withTime = (b) => (b.time != null ? `${b.text} [${fmtClock(b.time)}]` : b.text);

export function toText(doc) {
  const out = [doc.title, ...doc.meta, ''];
  for (const s of doc.sections) {
    out.push('', s.heading.toUpperCase(), '='.repeat(Math.min(60, s.heading.length)), '');
    for (const b of s.blocks) {
      if (b.t === 'h') out.push('', b.text, '-'.repeat(Math.min(60, b.text.length)));
      else if (b.t === 'li') out.push(`- ${withTime(b)}`);
      else out.push(withTime(b), ...(b.t === 'li' ? [] : ['']));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const mdEsc = (s) => String(s).replace(/([\\`*_[\]#|<>])/g, '\\$1');
export function toMarkdown(doc) {
  const out = [`# ${mdEsc(doc.title)}`, '', ...doc.meta.map((m) => `*${mdEsc(m)}*  `), ''];
  for (const s of doc.sections) {
    out.push(`## ${mdEsc(s.heading)}`, '');
    for (const b of s.blocks) {
      const t = b.time != null ? ` *(${fmtClock(b.time)})*` : '';
      if (b.t === 'h') out.push('', `### ${mdEsc(b.text)}`, '');
      else if (b.t === 'li') out.push(`- ${mdEsc(b.text)}${t}`);
      else if (b.t === 'quote') out.push(`> ${mdEsc(b.text)}${t}`, '');
      else if (b.t === 'meta') out.push(`*${mdEsc(b.text)}*`, '');
      else if (b.t === 'pre') out.push(...String(b.text).split('\n').map((l) => `${mdEsc(l)}  `), '');
      else out.push(`${mdEsc(b.text)}${t}`, '');
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export async function toDocx(doc) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
  const kids = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(doc.title)] }),
    ...doc.meta.map((m) => new Paragraph({ children: [new TextRun({ text: m, italics: true, color: '666666' })] })),
  ];
  const time = (b) => (b.time != null ? [new TextRun({ text: `  [${fmtClock(b.time)}]`, color: '0E7490' })] : []);
  for (const s of doc.sections) {
    kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320 }, children: [new TextRun(s.heading)] }));
    for (const b of s.blocks) {
      if (b.t === 'h') kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(b.text)] }));
      else if (b.t === 'li') kids.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(b.text), ...time(b)] }));
      else if (b.t === 'quote') kids.push(new Paragraph({ indent: { left: 480 }, children: [new TextRun({ text: b.text, italics: true }), ...time(b)] }));
      else if (b.t === 'meta') kids.push(new Paragraph({ children: [new TextRun({ text: b.text, italics: true, color: '666666' })] }));
      else if (b.t === 'pre') String(b.text).split('\n').forEach((l) => kids.push(new Paragraph({ children: [new TextRun(l)] })));
      else kids.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun(b.text), ...time(b)] }));
    }
  }
  return Packer.toBlob(new Document({ creator: 'SparkScribe', title: doc.title, sections: [{ children: kids }] }));
}

// The standard PDF fonts cover Windows-1252; a few common characters outside it get plain equivalents.
const PDF_MAP = { '→': '->', '←': '<-', '≈': '~', '¶': '', '✓': 'v', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ' };
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const pdfSafe = (s) => [...String(s)].map((ch) => {
  if (PDF_MAP[ch] != null) return PDF_MAP[ch];
  const c = ch.codePointAt(0);
  return c < 256 || CP1252_EXTRA.has(ch) ? ch : '?';
}).join('');

export async function toPdf(doc) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const M = 56, W = pdf.internal.pageSize.getWidth() - M * 2, H = pdf.internal.pageSize.getHeight();
  let y = M;
  const write = (text, { size = 11, bold = false, italic = false, color = [20, 24, 40], indent = 0, gap = 4, lead = 1.35 } = {}) => {
    pdf.setFont('helvetica', bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal');
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
    for (const line of pdf.splitTextToSize(pdfSafe(text), W - indent)) {
      if (y + size > H - M) { pdf.addPage(); y = M; }
      pdf.text(line, M + indent, y + size);
      y += size * lead;
    }
    y += gap;
  };
  write(doc.title, { size: 20, bold: true, gap: 6 });
  doc.meta.forEach((m) => write(m, { size: 10, italic: true, color: [100, 100, 110], gap: 0 }));
  y += 8;
  for (const s of doc.sections) {
    y += 8;
    write(s.heading, { size: 15, bold: true, gap: 6 });
    for (const b of s.blocks) {
      const t = withTime(b);
      if (b.t === 'h') write(b.text, { size: 12.5, bold: true, gap: 3 });
      else if (b.t === 'li') write(`•  ${t}`, { indent: 10, gap: 2 });
      else if (b.t === 'quote') write(t, { italic: true, indent: 16, color: [60, 60, 80] });
      else if (b.t === 'meta') write(t, { italic: true, size: 10, color: [100, 100, 110] });
      else if (b.t === 'pre') String(b.text).split('\n').forEach((l) => write(l || ' ', { gap: 0 }));
      else write(t);
    }
  }
  return pdf.output('blob');
}

// ---------- subtitles (only from real line timestamps) ----------
const srtTime = (s, sep) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
};
function cues(segments) {
  return segments.filter((s) => s.text.trim()).map((s, i, all) => {
    // a line's end is its own end; never past the next line's start, never zero length
    const next = all[i + 1]?.start;
    let end = s.end > s.start ? s.end : s.start + 2;
    if (next != null && end > next) end = Math.max(s.start + 0.2, next);
    return { start: s.start, end, text: s.speaker && s.speaker !== 'Unknown' ? `${s.speaker}: ${s.text}` : s.text };
  });
}
export const toSrt = (segments) => cues(segments).map((c, i) => `${i + 1}\n${srtTime(c.start, ',')} --> ${srtTime(c.end, ',')}\n${c.text}\n`).join('\n');
export const toVtt = (segments) => `WEBVTT\n\n${cues(segments).map((c) => `${srtTime(c.start, '.')} --> ${srtTime(c.end, '.')}\n${c.text}\n`).join('\n')}`;

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- the dialog ----------
/**
 * @param {object} o
 *   title, meta: [string], sources: [{ id, label, group, ready, note?, blocks() }], segments, coarse,
 *   preselect: source id, onDone(message)
 */
export function openExportDialog({ title, meta, sources, segments, coarse, preselect, onDone }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'confirm sheet export-dlg';
  const avail = sources.filter((s) => s.ready);
  const initial = new Set(preselect && avail.some((s) => s.id === preselect) ? [preselect] : avail.length ? [avail[0].id] : []);
  const groups = [...new Set(avail.map((s) => s.group))];
  dlg.innerHTML = `<h3>Export</h3>
    <form class="export-form">
      <fieldset><legend class="ins-label">What to export</legend>
        ${groups.map((g) => `<div class="exp-group">${g ? `<div class="exp-g">${esc(g)}</div>` : ''}${avail.filter((s) => s.group === g).map((s) => `<label class="exp-opt"><input type="checkbox" name="src" value="${esc(s.id)}" ${initial.has(s.id) ? 'checked' : ''} /><span>${esc(s.label)}${s.note ? ` <span class="ins-sub">${esc(s.note)}</span>` : ''}</span></label>`).join('')}</div>`).join('')}
        ${sources.some((s) => !s.ready) ? `<p class="ins-sub">Not created yet: ${sources.filter((s) => !s.ready).map((s) => esc(s.label)).join(', ')}.</p>` : ''}
      </fieldset>
      <fieldset><legend class="ins-label">Format</legend><div class="exp-formats"></div><p class="exp-why ins-sub" hidden></p></fieldset>
      <p class="dlg-err" role="alert" hidden></p>
      <div class="confirm-actions"><button class="btn btn-ghost" type="button" data-act="cancel">Cancel</button><button class="btn btn-primary" type="submit">Download</button></div>
    </form>`;
  document.body.appendChild(dlg);
  let closed = false;
  const dismiss = () => { if (closed) return; closed = true; if (dlg.open) dlg.close(); setTimeout(() => dlg.remove(), 200); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); });
  dlg.addEventListener('close', dismiss);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dismiss(); });
  dlg.querySelector('[data-act=cancel]').addEventListener('click', dismiss);
  const form = dlg.querySelector('form');
  const fmtBox = dlg.querySelector('.exp-formats');
  const why = dlg.querySelector('.exp-why');
  const err = dlg.querySelector('.dlg-err');
  let format = 'pdf';

  const selected = () => [...form.querySelectorAll('input[name=src]:checked')].map((i) => i.value);
  const renderFormats = () => {
    const sel = selected();
    const onlyTranscript = sel.length === 1 && sel[0] === 'transcript';
    const subsOk = onlyTranscript && !coarse && segments.length > 0;
    const reason = !onlyTranscript ? 'Subtitles are available for the original transcript on its own.'
      : coarse ? 'Subtitles need line-level timestamps; this recording was saved before they existed, so its timing would be invented.' : '';
    if (FORMATS[format].subtitles && !subsOk) format = 'pdf';
    fmtBox.innerHTML = Object.entries(FORMATS).map(([k, f]) => {
      const disabled = f.subtitles && !subsOk;
      return `<label class="exp-fmt${disabled ? ' off' : ''}"><input type="radio" name="fmt" value="${k}" ${format === k ? 'checked' : ''} ${disabled ? 'disabled' : ''} /><span>${esc(f.label)}</span></label>`;
    }).join('');
    why.hidden = !reason;
    why.textContent = reason;
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'fmt') format = e.target.value;
    else renderFormats();
  });
  renderFormats();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const sel = selected();
    if (!sel.length) { err.textContent = 'Choose at least one thing to export.'; err.hidden = false; return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      const chosen = sel.map((id) => avail.find((s) => s.id === id)).filter(Boolean);
      const f = FORMATS[format];
      const label = chosen.length === 1 ? chosen[0].label : 'Export';
      const name = `${fileBase(title, label === 'Original transcript' ? 'Transcript' : label)}.${f.ext}`;
      let blob;
      if (f.subtitles) blob = new Blob([format === 'srt' ? toSrt(segments) : toVtt(segments)], { type: f.mime });
      else {
        const doc = { title: chosen.length === 1 ? `${title} — ${label}` : title, meta, sections: chosen.map((s) => ({ heading: s.label, blocks: s.blocks() })) };
        blob = format === 'pdf' ? await toPdf(doc) : format === 'docx' ? await toDocx(doc)
          : new Blob([format === 'md' ? toMarkdown(doc) : toText(doc)], { type: f.mime });
      }
      download(blob, name);
      onDone?.(`Downloaded ${name}`);
      dismiss();
    } catch {
      err.textContent = 'That export didn’t work. Try another format.';
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Download';
    }
  });
  dlg.showModal();
}
