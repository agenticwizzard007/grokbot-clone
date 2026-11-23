import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';

const Renderer = lazy(() => import('./MarkdownRenderer').then(m => ({ default: m.Markdown })));

/** Assistant message markdown: paragraphs, lists, blockquotes, inline code, code blocks (screen 02), tables. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: element.closest('.transcript'), rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const plain = <div className="md" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>;
  // Plain text paints first. Parse only messages near the viewport, including
  // when a previously paged conversation is reopened from the local cache.
  return <div ref={ref}>{visible ? <Suspense fallback={plain}><Renderer text={text} /></Suspense> : plain}</div>;
});
