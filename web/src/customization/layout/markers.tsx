import type { ReactNode } from 'react';
import { useComponentVisible } from '../index';

/** The composer stays mounted; these markers only control its optional chrome. */
export function ComposerVisibility({ children }: { children: ReactNode }) {
  const safetyNote = useComponentVisible('chat.safetyNote');
  const modelChip = useComponentVisible('chat.modelChip');
  return <div className="ui-layout-contents" data-ui-id="chat.safetyNote" data-ui-visibility={safetyNote}>
    <div className="ui-layout-contents" data-ui-id="chat.modelChip" data-ui-visibility={modelChip}>{children}</div>
  </div>;
}
