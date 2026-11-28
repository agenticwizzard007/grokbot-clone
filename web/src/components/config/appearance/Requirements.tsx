import { useEffect, useState } from 'react';
import { ButtonGroup, Card, Row, Section } from '../../layout';
import { prefillComposer } from '../../Composer';
import { openConversation } from '../../../configStore';
import { useStore } from '../../../store';
import { appearanceRequest } from './api';
import { useSuggestionsAvailable, useUiConfig } from '../../../customization';
import '../../../styles/appearance.css';

type Profile = { role: string; goals: string[] };

/** Optional context for the user's dashboards, edited through their agent. */
export function Requirements({ embedded = false }: { embedded?: boolean }) {
  const available = useSuggestionsAvailable(), { status } = useUiConfig();
  const bots = useStore(state => state.bots);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!available) return;
    setLoading(true); setError('');
    let alive = true;
    void appearanceRequest<{ profile: Profile | null }>('/ui/requirements')
      .then(value => { if (alive) setProfile(value.profile); })
      .catch(() => { if (alive) setError('Could not load your profile.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [available]);
  const bot = bots.find(item => item.isPrimary && item.kind !== 'room') ?? bots.find(item => item.kind !== 'room');
  const ask = () => {
    if (!bot) return;
    prefillComposer(bot.id, 'Help me describe my role and goals for my dashboards: ');
    openConversation(bot.id);
  };
  return <Section title={embedded ? 'About you' : undefined} className="requirements-settings" aria-label="About you">
    <Card className="requirements-card">
      {!available ? <p role="status">{status === 'loading' ? 'Loading your profile...' : 'Dashboard suggestions are not available for your account yet.'}</p> : loading ? <p role="status">Loading your profile...</p> : error ? <p role="alert">{error}</p>
        : profile?.role || profile?.goals.length ? <Row title={profile.role || 'Your goals'} subtitle={profile.goals.join(' · ') || undefined} />
          : <p>Share your role and goals.</p>}
      <ButtonGroup><button type="button" className="cfg-btn cfg-btn--primary" disabled={!bot} onClick={ask}>Tell your agent</button></ButtonGroup>
    </Card>
  </Section>;
}
