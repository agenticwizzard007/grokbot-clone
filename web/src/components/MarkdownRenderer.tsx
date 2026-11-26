import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { inAppHash } from '../lib/savedFiles';

function MarkdownLink({ node: _n, ...props }: React.ComponentProps<'a'> & { node?: unknown }) {
  // Hash navigation keeps the transcript and its Back history in this tab.
  return <a {...props} target={inAppHash(props.href) ? undefined : '_blank'} rel="noreferrer noopener" />;
}

const components: Components = {
  a: MarkdownLink,
  table: ({ node: _n, ...props }) => (
    <div className="md-table"><table {...props} /></div>
  ),
};

/** Assistant message markdown: paragraphs, lists, blockquotes, inline code, code blocks (screen 02), tables. */
export const Markdown = React.memo(function Markdown({ text, savedFileLinks }: { text: string; savedFileLinks?: string[] }) {
  const renderedComponents = React.useMemo<Components>(() => savedFileLinks?.length ? {
    ...components,
    a: props => {
      const hash = inAppHash(props.href);
      // The completed tool result owns this navigation, even if the model repeats it.
      if (hash && savedFileLinks.includes(hash)) return (props.children === 'View saved files' || props.children === 'View Files') ? null : <>{props.children}</>;
      return <MarkdownLink {...props} />;
    },
  } : components, [savedFileLinks]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={renderedComponents}>{text}</ReactMarkdown>
    </div>
  );
});
