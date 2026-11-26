import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

const components: Components = {
  a: ({ node: _n, ...props }) => {
    // Hash navigation keeps the transcript and its Back history in this tab.
    let inApp = props.href?.startsWith('#') ?? false;
    if (!inApp && props.href && typeof window !== 'undefined') {
      try {
        const url = new URL(props.href, window.location.href);
        inApp = url.origin === window.location.origin && url.pathname === window.location.pathname
          && url.search === window.location.search && !!url.hash;
      } catch { /* Invalid links retain the external-link behavior. */ }
    }
    return <a {...props} target={inApp ? undefined : '_blank'} rel="noreferrer noopener" />;
  },
  table: ({ node: _n, ...props }) => (
    <div className="md-table"><table {...props} /></div>
  ),
};

/** Assistant message markdown: paragraphs, lists, blockquotes, inline code, code blocks (screen 02), tables. */
export const Markdown = React.memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>{text}</ReactMarkdown>
    </div>
  );
});
