/**
 * Render a terminal screen snapshot as an SVG "green screen" picture for the
 * Evidence Vault, the Studio screenshot gallery and the trace viewer. Input
 * fields are underlined, intensified fields are bright, the cursor is a block,
 * and an optional highlight marks the field a step acted on.
 */

export interface RenderableScreen {
  rows: number;
  cols: number;
  text: string[];
  cursor: { row: number; col: number };
  fields: Array<{ row: number; col: number; length: number; protected: boolean; intensified: boolean; hidden: boolean }>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderScreenSvg(s: RenderableScreen, highlight?: { row: number; col: number; length: number; label?: string }): string {
  const cw = 9;
  const ch = 18;
  const pad = 8;
  const w = s.cols * cw + pad * 2;
  const h = s.rows * ch + pad * 2;
  const x = (col: number) => pad + (col - 1) * cw;
  const y = (row: number) => pad + (row - 1) * ch;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="'IBM Plex Mono','DejaVu Sans Mono',Consolas,monospace" font-size="15">`,
    `<rect width="${w}" height="${h}" fill="#0b0f0b"/>`,
  ];
  // Field underlines (input fields) and intensified spans.
  const bright = new Set<string>();
  for (const f of s.fields) {
    if (f.length <= 0) continue;
    for (let i = 0; i < f.length; i++) {
      const a = (f.row - 1) * s.cols + (f.col - 1) + i;
      const r = Math.floor(a / s.cols) + 1;
      const c = (a % s.cols) + 1;
      if (r > s.rows) break;
      if (!f.protected) parts.push(`<rect x="${x(c)}" y="${y(r) + ch - 3}" width="${cw}" height="1.5" fill="#2f8f2f"/>`);
      if (f.intensified) bright.add(`${r}:${c}`);
    }
  }
  if (highlight) {
    parts.push(`<rect x="${x(highlight.col) - 2}" y="${y(highlight.row) - 1}" width="${highlight.length * cw + 4}" height="${ch + 2}" fill="none" stroke="#ffb000" stroke-width="2"/>`);
  }
  parts.push(`<rect x="${x(s.cursor.col)}" y="${y(s.cursor.row)}" width="${cw}" height="${ch}" fill="#3fbf3f" opacity="0.55"/>`);
  s.text.forEach((line, i) => {
    const r = i + 1;
    // Split each row into runs of normal / bright characters.
    let run = '';
    let runBright = false;
    let runStart = 1;
    const flush = (end: number) => {
      if (run.trim()) parts.push(`<text x="${x(runStart)}" y="${y(r) + ch - 5}" fill="${runBright ? '#e8ffe8' : '#33ff66'}" xml:space="preserve">${esc(run)}</text>`);
      run = '';
      runStart = end;
    };
    for (let c = 1; c <= line.length; c++) {
      const b = bright.has(`${r}:${c}`);
      if (b !== runBright && run) flush(c);
      if (!run) {
        runStart = c;
        runBright = b;
      }
      run += line[c - 1];
    }
    flush(line.length + 1);
  });
  if (highlight?.label) parts.push(`<title>${esc(highlight.label)}</title>`);
  parts.push('</svg>');
  return parts.join('');
}
