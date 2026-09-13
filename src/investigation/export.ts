import type { Snapshot } from './state';
import { downloadText, graphToJson, graphToMarkdown, graphToMermaid } from '../mindmap/exportText';

export type ExportFormat = 'html' | 'markdown' | 'mermaid' | 'json';

export const exportFormats: { format: ExportFormat; label: string; hint: string }[] = [
  {
    format: 'html',
    label: 'HTML page',
    hint: 'Offline page with the current canvas and all graph data',
  },
  {
    format: 'markdown',
    label: 'Markdown outline',
    hint: 'Indented outline of all notes and links',
  },
  {
    format: 'mermaid',
    label: 'Mermaid diagram',
    hint: 'Flowchart source for Markdown fences, GitHub or the Mermaid editor',
  },
  { format: 'json', label: 'JSON data', hint: 'Complete graph document' },
];

// Copy the properties used by cards and SVG paths, rather than every browser default per element.
const visualProperties = [
  'color',
  'background',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'display',
  'flex',
  'flex-direction',
  'align-items',
  'justify-content',
  'gap',
  'padding',
  'margin',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'overflow',
  'white-space',
  'text-overflow',
  'text-align',
  'text-transform',
  'letter-spacing',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'text-anchor',
  'paint-order',
  'opacity',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'transform',
  'box-sizing',
  'box-shadow',
  '-webkit-line-clamp',
  '-webkit-box-orient',
];

const graphTitle = (snapshot: Snapshot): string =>
  snapshot.records.find((node) => !node.parent)?.title || 'Reasoning graph';

/** File-system safe download name derived from the graph title. */
function exportFileName(title: string, extension: string): string {
  const slug = title
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `${slug || 'reasoning-graph'}.${extension}`;
}

/** Revision, caption and export time, e.g. for a heading. */
function exportSubtitle(snapshot: Snapshot, date = new Date()): string {
  return [`Revision ${snapshot.revision}`, snapshot.caption, date.toLocaleString()]
    .filter(Boolean)
    .join(' · ');
}

/** Save the current canvas plus complete graph data as a self-contained, offline HTML file. */
export function exportReasoningGraph(svg: SVGSVGElement, snapshot: Snapshot, date?: Date): void {
  const title = graphTitle(snapshot);
  const output = document.implementation.createHTMLDocument(title);
  const theme = getComputedStyle(svg);
  const style = output.createElement('style');
  // The page keeps the app theme so exported cards stay readable on the canvas background.
  style.textContent = `body{margin:24px;font:14px/1.5 system-ui,sans-serif;color:${
    theme.getPropertyValue('--fg').trim() || '#222'
  };background:${
    theme.getPropertyValue('--task-panel-bg').trim() || '#fff'
  }}h1{font-size:22px;margin-bottom:4px}.meta{margin:0 0 16px;opacity:.7}.canvas{overflow:auto;max-width:100%}details{margin-top:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}svg{display:block}`;
  output.head.append(style);
  const heading = output.createElement('h1');
  heading.textContent = title;
  const meta = output.createElement('p');
  meta.className = 'meta';
  meta.textContent = exportSubtitle(snapshot, date);
  output.body.append(heading, meta);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const sourceElements = [svg, ...svg.querySelectorAll('*')];
  const clonedElements = [clone, ...clone.querySelectorAll('*')];
  // Resolve theme variables and copy styles so the file does not depend on the app's CSS.
  for (let i = 0; i < sourceElements.length; i++) {
    const computed = getComputedStyle(sourceElements[i]);
    const target = clonedElements[i] as SVGElement | HTMLElement;
    for (const property of visualProperties)
      target.style.setProperty(property, computed.getPropertyValue(property));
    target.style.setProperty('animation', 'none');
    target.style.setProperty('transition', 'none');
  }
  const group = svg.querySelector('g');
  const clonedGroup = clone.querySelector('g');
  if (!group || !clonedGroup) throw new Error('The graph is not ready to export.');
  const bounds = group.getBBox();
  const width = Math.ceil(bounds.width + 48),
    height = Math.ceil(bounds.height + 48);
  clonedGroup.removeAttribute('transform');
  clonedGroup.style.removeProperty('transform');
  clone.setAttribute('viewBox', `${bounds.x - 24} ${bounds.y - 24} ${width} ${height}`);
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.position = 'static';
  clone.style.inset = 'auto';
  clone.style.background = theme.getPropertyValue('--task-panel-bg');
  const canvas = output.createElement('div');
  canvas.className = 'canvas';
  canvas.append(clone);
  output.body.append(canvas);
  // Include all saved notes, even when their branches are collapsed in the exported view.
  const details = output.createElement('details');
  const summary = output.createElement('summary');
  summary.textContent = 'Complete graph data, notes and connections (JSON)';
  const data = output.createElement('pre');
  data.textContent = JSON.stringify(
    { format: 'parallel-code-reasoning', version: 1, snapshot },
    null,
    2,
  );
  details.append(summary, data);
  output.body.append(details);
  const url = URL.createObjectURL(
    new Blob(['<!doctype html>\n', output.documentElement.outerHTML], {
      type: 'text/html;charset=utf-8',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(title, 'html');
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Export in the chosen format; the HTML page needs the rendered canvas. */
export function exportReasoningGraphAs(
  format: ExportFormat,
  snapshot: Snapshot,
  svg: SVGSVGElement | null,
): void {
  const title = graphTitle(snapshot);
  if (format === 'html') {
    if (!svg) throw new Error('The graph is not ready to export.');
    exportReasoningGraph(svg, snapshot);
  } else if (format === 'markdown')
    downloadText(
      exportFileName(title, 'md'),
      graphToMarkdown(snapshot, `${title} · ${exportSubtitle(snapshot)}`),
      'text/markdown;charset=utf-8',
    );
  else if (format === 'mermaid')
    downloadText(
      exportFileName(title, 'mmd'),
      graphToMermaid(snapshot, `${title} · ${exportSubtitle(snapshot)}`),
      'text/plain;charset=utf-8',
    );
  else downloadText(exportFileName(title, 'json'), graphToJson(snapshot), 'application/json');
}
