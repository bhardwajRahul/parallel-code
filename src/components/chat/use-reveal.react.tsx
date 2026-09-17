/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';

/** Animate display text only. History and clipboard content keep the received text. */
export function useReveal(text: string, running: boolean): string {
  const [visible, setVisible] = useState(text);
  const shown = useRef(text);
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const flush = () => {
      cancelAnimationFrame(frame);
      shown.current = text;
      setVisible(text);
    };
    if (!running || motion.matches || !text.startsWith(shown.current)) {
      flush();
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      const rest = Array.from(text.slice(shown.current.length));
      const count = Math.min(
        rest.length,
        Math.floor((now - last) / Math.min(5, 250 / Math.max(1, rest.length))),
      );
      if (count > 0) {
        shown.current += rest.slice(0, count).join('');
        last = now;
        setVisible(shown.current);
      }
      if (shown.current !== text) frame = requestAnimationFrame(tick);
    };
    const onMotion = () => {
      if (motion.matches) flush();
    };
    frame = requestAnimationFrame(tick);
    motion.addEventListener('change', onMotion);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener('change', onMotion);
    };
  }, [text, running]);
  return running && text.startsWith(visible) ? visible : text;
}
