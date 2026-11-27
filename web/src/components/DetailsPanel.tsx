import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Settings, MessageSquare, ChartNoAxesColumn, ListTodo, Folder, SlidersHorizontal } from 'lucide-react';
import type { Bot } from '@shared/types';
import { clearImportedSetup, hasImportedSetup } from '../lib/setupApi';
import { useSelectedBot, useStore } from '../store';
import { openConversation, detailsCaller, useConfigUI } from '../configStore';
import { LibraryTab } from './config/LibraryTab';
import { FilesSummary } from './config/FilesSummary';
import { DeliverablesPanel } from './config/DeliverablesPanel';
import { BotTasksPage } from './config/BotTasksPage';
import { AgentConfiguration } from './config/AgentConfiguration';
import { hasOpenModal } from './modals/Modal';
import { computerStatusText } from './config/computerStatus';
import { Page } from './layout';
import { BotActivity } from './config/BotActivity';
import '../styles/setup-paper.css';
import '../styles/bot-details.css';

// Shared with the viewer and Settings; the copy lives in config/computerStatus (R2F-021).
export { computerStatusText };

const sections = [
  { id: 'activity', label: 'Activity', icon: ChartNoAxesColumn }, { id: 'tasks', label: 'Tasks', icon: ListTodo }, { id: 'library', label: 'Files', icon: Folder }, { id: 'configuration', label: 'Setup', icon: SlidersHorizontal },
] as const;
type DetailTab = typeof sections[number]['id'];

export function DetailsPanel() {
  const bot = useSelectedBot();
  const userId = useStore(state => state.user?.id);
  return bot ? <ConversationDetails key={JSON.stringify([userId, bot.id])} bot={bot} userId={userId} /> : null;
}

function ConversationDetails({ bot, userId }: { bot: Bot; userId?: string }) {
  const panel = useRef<HTMLElement>(null);
  const [headerHost, setHeaderHost] = useState<Element | null>(null);
  useLayoutEffect(() => { setHeaderHost(document.querySelector('.shell-header')); }, []);
  const returnFocus = useRef<HTMLElement | null>(null);
  const tab = useConfigUI(state => state.detailsTab);
  const reports = useConfigUI(state => state.detailsReports);
  const setTab = (tab: DetailTab) => useConfigUI.getState().setDetailsTab(tab);
  const setReports = (reports: boolean) => useConfigUI.getState().setDetailsTab('library', undefined, reports);
  useEffect(() => {
    if (hasImportedSetup(userId, bot.id)) useConfigUI.getState().setDetailsTab('configuration');
    clearImportedSetup(userId, bot.id);
  }, [userId, bot.id]);
  const close = () => {
    useStore.getState().set({ detailsOpen: false });
    requestAnimationFrame(() => {
      // Do not override focus already restored by cleanup or moved by the user.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && active.isConnected && active.getClientRects().length) return;
      const target = returnFocus.current;
      if (target?.isConnected && target.getClientRects().length && !target.closest('[inert]')) target.focus({ preventScroll: true });
    });
  };
  useLayoutEffect(() => {
    const element = panel.current;
    const previous = detailsCaller && detailsCaller !== document.body ? detailsCaller : document.querySelector<HTMLElement>('.chat__bot-details');
    returnFocus.current = previous;
    element?.querySelector<HTMLButtonElement>('[aria-current]')?.focus({ preventScroll: true });
    return () => {
      // History traversal is asynchronous. Wait until the chat is visible and
      // its inert state has been removed before returning keyboard focus.
      requestAnimationFrame(() => {
        if (useStore.getState().detailsOpen || useStore.getState().modal || useConfigUI.getState().appSettings || useConfigUI.getState().botSettings) return;
        if (previous?.isConnected && previous.getClientRects().length && !previous.closest('[inert], [hidden]')) previous.focus({ preventScroll: true });
      });
    };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || hasOpenModal() || !panel.current?.getClientRects().length) return;
      event.preventDefault(); close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  const openSettings = () => useConfigUI.getState().openBotSettings(bot.id);
  const navigation = <nav className="pb-bot-tabs" aria-label="Conversation details sections">
    <button type="button" onClick={() => openConversation(bot.id)}><MessageSquare size={18} aria-hidden /><span>Chat</span></button>
    {sections.filter(section => bot.kind !== 'room' || section.id !== 'configuration').map(section =>
      <button key={section.id} type="button" aria-current={tab === section.id || undefined} onClick={() => setTab(section.id)}><section.icon size={18} aria-hidden /><span>{section.label}</span></button>)}
    <button type="button" className="pb-bot-tabs__settings" aria-label="Bot settings" onClick={openSettings}><Settings size={18} aria-hidden /><span>Settings</span></button>
  </nav>;
  return <aside id="bot-details" ref={panel} className={`details details--page pb-details${tab === 'configuration' ? ' details--configuration' : ''}`} aria-label="Conversation details">
    {headerHost && createPortal(<button type="button" className="pb-bot-settings-gear" aria-label="Bot settings" onClick={openSettings}><Settings size={20} aria-hidden /></button>, headerHost)}
    {navigation}
    <Page type="form">
      {tab === 'activity' && <BotActivity bot={bot} />}
      {tab === 'tasks' && <BotTasksPage bot={bot} />}
      {tab === 'configuration' && <AgentConfiguration bot={bot} />}
      {tab === 'library' && (reports ? <DeliverablesPanel botId={bot.id} /> : <>
        <FilesSummary bot={bot} onReports={() => setReports(true)} />
        <LibraryTab bot={bot} />
      </>)}
    </Page>
  </aside>;
}
