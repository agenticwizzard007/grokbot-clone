import { useState } from 'react';
import { Check } from 'lucide-react';
import { Page, Section, Card, ButtonGroup } from './layout';
import { ProviderMark } from './ProviderMark';
import { useConfigUI } from '../configStore';
import '../styles/signin-brand.css';

const options = [
  { provider: 'claude', title: 'Claude plan', detail: 'Pro or Max' },
  { provider: 'openai', title: 'ChatGPT plan', detail: 'Plus or Pro' },
  { provider: 'openrouter', title: 'OpenRouter key', detail: 'Pay per use' },
] as const;

export function FirstRun() {
  const [choice, setChoice] = useState(0);
  const selected = options[choice];
  const continueSetup = () => {
    const ui = useConfigUI.getState();
    if (selected.provider === 'openrouter') ui.openAppSettings('keys');
    else { ui.openAppSettings('subscriptions'); useConfigUI.setState({ subscriptionProvider: selected.provider === 'claude' ? 'claude' : 'codex' }); }
  };
  return <main className="first-run">
    <Page type="form" title="Connect a model">
      <div className="first-run__progress" aria-label="Step 2 of 3"><span /><span /><span /></div>
      <Section title="Step 2 of 3">
        {options.map((option, index) => <Card key={option.provider} className={choice === index ? 'first-run__selected' : undefined}>
          <button type="button" className="first-run__option" aria-pressed={choice === index} onClick={() => setChoice(index)}>
            <ProviderMark provider={option.provider} /><span>{option.title}<small>{option.detail}</small></span>{choice === index && <Check size={20} aria-hidden />}
          </button>
        </Card>)}
      </Section>
      <Card>Next: {choice === 2 ? 'add your key' : 'sign in'}</Card>
      <ButtonGroup stack><button type="button" className="btn btn--primary" onClick={continueSetup}>Continue</button></ButtonGroup>
    </Page>
  </main>;
}
