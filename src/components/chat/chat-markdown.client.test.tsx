import { createRoot, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_LINK_PREFIX, createChatMarkdown, renderChatMarkdown } from './chat-markdown';

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

// happy-dom's DOM does not let DOMPurify strip attributes as a browser does, so the
// shared sanitize policy is not asserted here; the link rules below do not rely on it.
describe('chat markdown', () => {
  it('routes cited worktree files to the editor, including file:line locations', () => {
    const html = renderChatMarkdown('See [app](src/app.ts) and [readme](README.md:12).');
    expect(hrefs(html)).toEqual([
      `${FILE_LINK_PREFIX}${encodeURIComponent('src/app.ts')}`,
      `${FILE_LINK_PREFIX}${encodeURIComponent('README.md:12')}`,
    ]);
  });

  it('leaves web, mail and in-page links as written', () => {
    const html = renderChatMarkdown(
      '[docs](https://example.com/a) [mail](mailto:a@example.com) [top](#top)',
    );
    expect(hrefs(html)).toEqual(['https://example.com/a', 'mailto:a@example.com', '#top']);
  });

  it('shows a script link as its text, never as a link', () => {
    const html = renderChatMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click me');
  });

  it('renders an unclosed code fence mid-stream without swallowing earlier text', () => {
    const html = renderChatMarkdown('Run this:\n\n```sh\nnpm test');
    expect(html).toContain('Run this:');
    expect(html).toContain('<code class="language-sh">npm test');
  });

  it('shows raw HTML from the agent as text, keeping only line breaks', () => {
    const html = renderChatMarkdown(
      '<div style="position:fixed;inset:0">Click</div>\n\nA <span id="x">tag</span> | a<br>b',
    );
    expect(html).not.toMatch(/<(div|span)\b/);
    expect(html).toContain('&lt;div style="position:fixed;inset:0"&gt;');
    expect(html).toContain('&lt;span id="x"&gt;tag&lt;/span&gt;');
    expect(html).toContain('a<br>b');
  });

  it('keeps raw HTML as text once code blocks are highlighted', async () => {
    const source = '<img src=x onerror=alert(1)>\n\n```ts\nconst a = 1;\n```';
    const html = createRoot(() =>
      createChatMarkdown(
        () => source,
        () => false,
      ),
    );
    await vi.waitFor(() => expect(html()).toContain('shiki-block'));
    expect(html()).not.toContain('<img');
    expect(html()).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  describe('while streaming', () => {
    afterEach(() => vi.useRealTimers());

    it('re-renders at most every 60ms and always lands on the latest text', () => {
      vi.useFakeTimers();
      const [text, setText] = createSignal('a');
      const [streaming, setStreaming] = createSignal(true);
      const html = createRoot(() => createChatMarkdown(text, streaming));
      setText('ab');
      expect(html()).toContain('ab');
      setText('abc');
      setText('abcd');
      expect(html()).not.toContain('abc');
      vi.advanceTimersByTime(60);
      expect(html()).toContain('abcd');
      setText('abcde');
      setStreaming(false);
      expect(html()).toContain('abcde');
    });
  });
});
