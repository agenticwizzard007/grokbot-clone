import * as React from 'react';
import { PreviewBody } from './PreviewBody';
import { toolPreviews, type ToolPreview } from './actionPreview';

export function PreviewContent({ preview }: { preview: ToolPreview }) {
  return <div className={`tool-preview is-${preview.kind}`} role="group" aria-label={`${preview.kind === 'generic' ? 'Action' : preview.kind[0].toUpperCase() + preview.kind.slice(1)} preview`}>
    {!!preview.fields.length && <dl className="tool-preview__fields">{preview.fields.map((field, i) => <div key={i}>
      <dt>{field.label}</dt><dd>{field.value.length > 700 ? <PreviewBody text={field.value} /> : field.value}</dd>
    </div>)}</dl>}
    {preview.body && <PreviewBody text={preview.body} slack={preview.kind === 'slack'} />}
    {preview.notes.map((note, i) => <p className="tool-preview__note" key={i}>{note}</p>)}
  </div>;
}

export function ActionPreview({ tool, args }: { tool: string; args: unknown }) {
  return <React.Fragment>{toolPreviews(tool, args).map((preview, i) => <PreviewContent preview={preview} key={i} />)}
    {args !== undefined && <details className="tool-preview__details"><summary>Details</summary><pre>{JSON.stringify(args, null, 2)}</pre></details>}
  </React.Fragment>;
}
